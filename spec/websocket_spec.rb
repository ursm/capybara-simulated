require 'capybara/simulated'
require 'websocket/driver'
require_relative 'support/session_teardown'

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

  # The close codes the server hears, as its connections close.
  let(:closes) { Thread::Queue.new }
  let(:app) {
    closes = self.closes
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
        driver.on(:close) {|e| closes << e.code }
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
      elsif env['PATH_INFO'] == '/worker'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>start</title></head><body>
            <script>
              window.w = new Worker('/w.js');
              window.w.onmessage = function (e) { document.title = e.data; };
            </script>
          </body></html>
        HTML
      elsif env['PATH_INFO'] == '/w.js'
        [200, {'content-type' => 'text/javascript'}, [<<~JS]]
          const ws = new WebSocket('ws://' + location.host + '/cable');
          ws.onopen    = () => ws.send('ping');
          ws.onmessage = (e) => { if (e.data.startsWith('echo:')) postMessage(e.data); };
          onmessage    = () => close();
        JS
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
  let(:session) { simulated_session(app) }
  before { session.visit('/') }

  it 'opens, receives a server push, and echoes a sent frame' do
    expect(session).to have_title(/hello/)        # server push delivered
    expect(session).to have_title(/echo:ping/)    # client send round-tripped
    expect(session.evaluate_script('window.wsOpen')).to be(true)
    expect(session.evaluate_script('window.ws.readyState')).to eq(1)   # OPEN
  end

  # Binary frames round-trip, including bytes ≥ 0x80 (200 here), which would
  # corrupt if either direction crossed the host boundary as a UTF-8 string.
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

  # HTML: a document's WebSockets are made to disappear as it is unloaded, and a worker's as it ends — the server hears
  # Going Away, rather than a connection that lives on until the session's reset.
  describe 'closing with its client' do
    it 'closes the document\'s sockets as a navigation replaces it' do
      expect(session).to have_title(/echo:ping/)
      expect(closes).to be_empty
      session.visit('/?next')
      expect(closes.pop(timeout: 5)).to eq(1001)
    end

    it 'runs a worker\'s socket, and closes it as the worker is terminated' do
      expect(session).to have_title(/echo:ping/)
      session.visit('/worker')
      expect(session).to have_title('echo:ping')
      expect(closes.pop(timeout: 5)).to eq(1001)   # (the first page's, which the visit replaced)
      session.execute_script('window.w.terminate()')
      expect(closes.pop(timeout: 5)).to eq(1001)
    end

    it 'closes a worker\'s socket as a navigation replaces the worker\'s document' do
      expect(session).to have_title(/echo:ping/)
      session.visit('/worker')
      expect(session).to have_title('echo:ping')
      expect(closes.pop(timeout: 5)).to eq(1001)   # (the first page's, which the visit replaced)
      session.visit('/?next')
      expect(closes.pop(timeout: 5)).to eq(1001)   # (its worker's — the page itself has none)
    end

    it 'closes a worker\'s socket as the worker closes itself' do
      expect(session).to have_title(/echo:ping/)
      session.visit('/worker')
      expect(session).to have_title('echo:ping')
      expect(closes.pop(timeout: 5)).to eq(1001)   # (the first page's, which the visit replaced)
      session.execute_script('window.w.postMessage("close")')
      expect(closes.pop(timeout: 5)).to eq(1001)
    end
  end
end
