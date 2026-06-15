require 'capybara/simulated'
require 'websocket/driver'
require_relative 'support/js_engine'

# WebSocket transport: `new WebSocket(url)` rides the in-process `rack.hijack`
# socket (Browser#ws_open) — the same substrate Action Cable uses. This spec
# stands up a minimal echo server with websocket-driver (Action Cable's own
# framing lib) over a hijacked connection, exercising csim's hand-rolled
# RFC6455 client: handshake, server push, client send + echo, and close.
RSpec.describe 'WebSocket' do
  # websocket-driver expects a socket-like object exposing the rack `env`
  # (it reads the handshake from there) and `write` (for the 101 + frames).
  class WsConn
    attr_reader :env
    def initialize(env, io) = (@env, @io = env, io)
    def write(bytes) = @io.write(bytes)
  end

  let(:app) {
    lambda do |env|
      if env['HTTP_UPGRADE'].to_s.downcase == 'websocket'
        io     = env['rack.hijack'].call
        conn   = WsConn.new(env, io)
        driver = WebSocket::Driver.rack(conn)
        driver.on(:open) { driver.text('hello') }   # server push on connect
        # Echo text as text and binary as binary. websocket-driver delivers a
        # binary message as a BINARY-encoded String (or an Array on older
        # versions); text comes as a UTF-8 String.
        driver.on(:message) do |e|
          if e.data.is_a?(Array) || (e.data.is_a?(String) && e.data.encoding == Encoding::BINARY)
            driver.binary(e.data)
          else
            driver.text("echo:#{e.data}")
          end
        end
        driver.start                                              # writes the 101
        Thread.new do
          Thread.current.report_on_exception = false
          loop do
            chunk = (io.readpartial(4096) rescue nil)
            break unless chunk
            driver.parse(chunk)
          end
        end
        [101, {}, []]   # ignored — the connection is hijacked
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>start</title></head><body>
            <script>
              window.wsMsgs = [];
              var ws = new WebSocket('ws://' + location.host + '/cable');
              ws.binaryType = 'arraybuffer';
              window.ws = ws;
              ws.onopen    = function () { window.wsOpen = true; ws.send('ping'); };
              ws.onmessage = function (e) {
                if (typeof e.data === 'string') { window.wsMsgs.push(e.data); document.title = window.wsMsgs.slice().sort().join('|'); }
                else { window.wsBin = Array.from(new Uint8Array(e.data)); document.title = 'bin:' + window.wsBin.join(','); }
              };
              ws.onclose   = function (e) { window.wsClosed = e.code; document.title = 'closed:' + e.code; };
            </script>
          </body></html>
        HTML
      end
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }
  before { session.visit('/') }

  it 'opens, receives a server push, and echoes a sent frame' do
    expect(session).to have_title(/hello/)        # server push delivered
    expect(session).to have_title(/echo:ping/)    # client send round-tripped
    expect(session.evaluate_script('window.wsOpen')).to be(true)
    expect(session.evaluate_script('window.ws.readyState')).to eq(1)   # OPEN
  end

  # Binary frames round-trip on both engines, including bytes ≥ 0x80 (200 here)
  # which used to corrupt over QuickJS's host boundary — the send path now
  # base64-encodes for QuickJS, the receive path already does via wrap_binary.
  it 'round-trips a binary frame as an ArrayBuffer' do
    expect(session).to have_title(/hello/)                 # connection established
    session.execute_script('window.ws.send(new Uint8Array([5, 200, 7]))')
    expect(session).to have_title('bin:5,200,7')
    expect(session.evaluate_script('window.wsBin')).to eq([5, 200, 7])
  end

  it 'reports readyState transitions and fires close' do
    expect(session).to have_title(/hello/)
    session.execute_script('window.ws.close()')
    expect(session).to have_title('closed:1000')                       # close handshake completed
    expect(session.evaluate_script('window.ws.readyState')).to eq(3)   # CLOSED
  end
end
