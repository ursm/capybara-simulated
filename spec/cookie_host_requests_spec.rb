# frozen_string_literal: true

require 'digest'
require 'tmpdir'
require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# The requests the host makes outside a fetch's or a navigation's chain judge their cookies by their client's site for
# cookies all the same (cookie_jar.rs `context_for_ruby`): a WebSocket handshake by its document's — a cross-site one
# sends no SameSite cookie, and its Set-Cookie stores none — and a download as the top-level navigation it is, its
# response's cookies stored.
RSpec.describe "the cookies of a host's own request" do
  let(:seen) { [] }
  let(:app) {
    seen = self.seen
    lambda {|env|
      req = Rack::Request.new(env)
      case req.path
      when '/set'
        [200, {'content-type' => 'text/html', 'set-cookie' => ['s=1; SameSite=Strict; Path=/', 'l=1; SameSite=Lax; Path=/']}, ['set']]
      when '/ws'
        # (…a handshake answered by hand: its 101, a cookie of its own)
        seen << ["#{req.host} ws", env['HTTP_COOKIE'].to_s, env['HTTP_ORIGIN'], env['HTTP_REFERER']]
        accept = Digest::SHA1.base64digest(env['HTTP_SEC_WEBSOCKET_KEY'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        io = env['rack.hijack'].call
        io.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" \
                 "Sec-WebSocket-Accept: #{accept}\r\nSet-Cookie: ws=1; Path=/\r\n\r\n")
        [101, {}, []]
      when '/file'
        [200, {'content-type' => 'text/plain', 'content-disposition' => 'attachment; filename="f.txt"', 'set-cookie' => 'dl=1; Path=/'}, ['f']]
      when '/framed'
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><iframe src="http://b.test/frame"></iframe>']]
      when '/frame'
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><script>new WebSocket('ws://a.test/ws')</script>"]]
      when '/echo'
        seen << ["#{req.host} echo", env['HTTP_COOKIE'].to_s]
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>echo']]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><a href="/file" download>d</a>']]
      end
    }
  }

  it "judges a WebSocket's handshake by its document's site" do
    s = every_host_local { simulated_session(app) }
    s.visit 'http://b.test/set'
    s.visit 'http://a.test/set'
    s.visit 'http://a.test/'
    s.execute_script("window.near = new WebSocket('ws://a.test/ws'); window.far = new WebSocket('ws://b.test/ws');")
    s.evaluate_script('1')
    s.visit 'http://a.test/echo'
    s.visit 'http://b.test/echo'
    # (…the same-site one its document's SameSite cookies, its own stored; the cross-site one none, none stored)
    expect(seen).to contain_exactly(
      ['a.test ws', 's=1; l=1', 'http://a.test', 'http://a.test/'],
      ['b.test ws', '', 'http://a.test', 'http://a.test/'],
      ['a.test echo', 's=1; l=1; ws=1'],
      ['b.test echo', 's=1; l=1']
    )
  end

  # (…a frame's by its own document's site for cookies — its ancestors' too — not its top-level document's: a
  # cross-site frame's socket to the top's site none, of the frame's origin)
  it "judges a frame's WebSocket by the frame's site for cookies" do
    s = every_host_local { simulated_session(app) }
    s.visit 'http://a.test/set'
    s.visit 'http://a.test/framed'
    s.evaluate_script('1')
    expect(seen).to eq([['a.test ws', '', 'http://b.test', 'http://b.test/']])
  end

  # (…an about:blank popup's by its opener's origin, which it inherits; a srcdoc frame's referred by its container's
  # document; a sandboxed one's of the opaque origin `null`, referred by none)
  it 'judges a socket by the document it is of, whatever its URL' do
    s = every_host_local { simulated_session(app) }
    s.visit 'http://a.test/set'
    s.visit 'http://a.test/'
    s.execute_script(<<~JS)
      window.open('').eval("new WebSocket('ws://a.test/ws')");
      const doc = document.body.appendChild(document.createElement('iframe'));
      doc.srcdoc = "<script>new WebSocket('ws://a.test/ws')<" + "/script>";
      const boxed = document.body.appendChild(document.createElement('iframe'));
      boxed.sandbox = 'allow-scripts';
      boxed.srcdoc = "<script>new WebSocket('ws://a.test/ws')<" + "/script>";
    JS
    3.times { s.evaluate_script('1') }
    expect(seen).to contain_exactly(
      ['a.test ws', 's=1; l=1', 'http://a.test', nil],
      ['a.test ws', 's=1; l=1', 'http://a.test', 'http://a.test/'],
      ['a.test ws', '', 'null', nil]
    )
  end

  it "stores a download's cookies, a navigation's response" do
    Dir.mktmpdir do |dir|
      prev = ENV['CSIM_DOWNLOADS_DIR']
      ENV['CSIM_DOWNLOADS_DIR'] = dir
      s = simulated_session(app)
      s.visit '/'
      s.click_link 'd'
      s.visit '/echo'
      expect(seen).to eq([['www.example.com echo', 'dl=1']])
    ensure
      ENV['CSIM_DOWNLOADS_DIR'] = prev
    end
  end
end
