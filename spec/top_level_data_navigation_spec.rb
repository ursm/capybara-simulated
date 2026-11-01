# frozen_string_literal: true

require 'capybara/simulated'
require 'tmpdir'
require_relative 'support/session_teardown'

# A document's navigation of the top-level browsing context to a `data:` URL it would render is refused — a link's, a
# form's, `location`'s, `open(url, '_self')`'s, the page's own or a frame's `_top` (Chrome, measured 2026-10-30) — the
# page staying where it is. The user's own — the address bar, the driver's `visit` — is not: its document is of a new
# opaque origin. And one whose MIME type makes no document is a download, whoever navigates — a link's, `location`'s, a
# form's, a frame's — the navigable left at the document it is at (Chrome and Firefox, measured 2026-11-01; HTML
# "loading a document"; navigation_fetch.rs `data_navigation`).
RSpec.describe 'a top-level navigation to a data: URL' do
  let(:target) { 'data:text/html,<title>landed</title>' }
  let(:download) { 'data:application/octet-stream,abc' }
  let(:session) do
    data, saved = target, download
    simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/'
               %(<a id=link href="#{data}">link</a><a id=dl href="#{saved}">dl</a><iframe name=f src=/frame></iframe>
                 <a id=frame-dl href="#{saved}" target=f>frame dl</a>
                 <form id=form action="#{saved}"><input name=q value=1></form>)
             else %(<a id=top href="#{data}" target=_top>top</a>)
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>start</title><body>#{body}"]]
    })
  end

  around do |example|
    Dir.mktmpdir do |dir|
      @downloads = dir
      ENV['CSIM_DOWNLOADS_DIR'] = dir
      example.run
    ensure
      ENV.delete('CSIM_DOWNLOADS_DIR')
    end
  end

  it 'opens a new window at about:blank for open(data:)' do
    session.visit '/'
    session.execute_script("window.popup = open('#{target}')")
    expect([session.evaluate_script('popup.location.href'), session.title]).to eq(['about:blank', 'start'])
  end

  {
    'a link'              => "document.getElementById('link').click()",
    'location'            => "location.href = 'TARGET'",
    "open(url, '_self')"  => "open('TARGET', '_self')",
    "a frame's _top link" => "frames[0].document.getElementById('top').click()"
  }.each do |what, script|
    it "refuses #{what}'s" do
      session.visit '/'
      session.execute_script(script.sub('TARGET', target))
      session.evaluate_script('1')
      expect([session.title, session.current_path]).to eq(['start', '/'])
    end
  end

  it "loads the user's visit as a document of an opaque origin" do
    session.visit '/'
    session.visit 'data:text/html;charset=utf-8,<p id=p>h%C3%A9</p><script>document.title = origin</script>'
    expect(session).to have_css('#p', text: 'hé')
    expect([session.title, session.current_url]).to eq(['null', 'data:text/html;charset=utf-8,<p id=p>h%C3%A9</p><script>document.title = origin</script>'])
    expect(session.evaluate_script('[document.contentType, (() => { try { return localStorage.length } catch (e) { return e.name } })()]')).to eq(['text/html', 'SecurityError'])
    session.go_back
    expect(session.title).to eq('start')
    session.go_forward
    expect(session).to have_css('#p', text: 'hé')
  end

  it "loads the user's visit of a plain text one as text" do
    session.visit 'data:,hello%20there'
    expect(session.evaluate_script('[document.contentType, document.body.textContent]')).to eq(['text/plain', 'hello there'])
  end

  it "loads the user's visit in a window of its own" do
    session.visit '/'
    popup = session.window_opened_by { session.execute_script("open('/frame', 'w')") }
    session.within_window(popup) do
      session.visit target
      expect(session.title).to eq('landed')
      expect(session.evaluate_script('origin')).to eq('null')
    end
  end

  {
    'the user'   => nil,
    'a link'     => "document.getElementById('dl').click()",
    'location'   => "location.href = 'DOWNLOAD'",
    'a form'     => "document.getElementById('form').submit()",
    "a frame's"  => "document.getElementById('frame-dl').click()"
  }.each do |what, script|
    it "downloads one of a type that makes no document, by #{what}" do
      session.visit '/'
      script ? session.execute_script(script.sub('DOWNLOAD', download)) : session.visit(download)
      session.evaluate_script('1')
      expect([session.title, session.current_path]).to eq(['start', '/'])
      expect(Dir.children(@downloads)).to eq(['download'])
      expect(File.read(File.join(@downloads, 'download'))).to eq(script&.include?('form') ? 'abc?q=1' : 'abc')
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/frame')
    end
  end
end
