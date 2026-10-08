require 'capybara/simulated'
require 'websocket/driver'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

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
  # …and the reasons they close with.
  let(:reasons) { Thread::Queue.new }
  let(:app) {
    closes = self.closes
    reasons = self.reasons
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
        driver.on(:close) do |e|
          closes << e.code
          reasons << e.reason
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
      elsif env['PATH_INFO'] == '/framed'
        [200, {'content-type' => 'text/html'}, ['<!doctype html><base href="/sub/dir/"><body><iframe src="/blank"></iframe>']]
      elsif env['PATH_INFO'] == '/blank'
        [200, {'content-type' => 'text/html'}, ['<!doctype html><body>']]
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

  # A Blob is a binary frame of its bytes (WebSockets §3: send(Blob)), not its string form.
  it 'sends a Blob as a binary frame' do
    expect(session).to have_title(/hello/)
    session.execute_script("window.ws.send(new Blob([new Uint8Array([9, 250])]))")
    expect(session).to have_title('bin:9,250')
  end

  # What send() is given once closing never leaves, so it stays counted in bufferedAmount (Chrome: 3 after close()).
  it 'counts what is sent once closing in bufferedAmount' do
    expect(session).to have_title(/hello/)
    expect(session.evaluate_script("(() => { window.ws.close(); window.ws.send('abc'); return window.ws.bufferedAmount; })()")).to eq(3)
    expect(session).to have_title('closed:1000')
    expect(session.evaluate_script('window.ws.bufferedAmount')).to eq(3)
  end

  # What was sent while open is gone from bufferedAmount once the event loop turns, a close() in the same task or not;
  # a detached buffer sends nothing, without throwing; a reason with no code closes with 1000 and the reason.
  it 'drains bufferedAmount, takes a detached buffer, and closes with a reason' do
    expect(session).to have_title(/hello/)
    got = session.evaluate_script(<<~JS)
      (() => {
        const buffer = new ArrayBuffer(4), view = new Uint8Array(buffer), dataView = new DataView(buffer);
        structuredClone(buffer, {transfer: [buffer]});
        window.ws.send(dataView);
        window.ws.send('ab');
        window.ws.send(buffer);
        window.ws.close(undefined, 'bye');
        window.ws.send(view);
        return window.ws.bufferedAmount;
      })()
    JS
    expect(got).to eq(2)
    expect(session).to have_title('closed:1000')
    expect(session.evaluate_script('window.ws.bufferedAmount')).to eq(0)
    expect([closes.pop(timeout: 5), reasons.pop(timeout: 5)]).to eq([1000, 'bye'])
  end

  # A close() while connecting fails the connection: an `error`, then an abnormal close.
  it 'fires error and then close for a close() while connecting' do
    expect(session).to have_title(/hello/)
    session.execute_script(<<~JS)
      window.order = [];
      const early = new WebSocket('ws://' + location.host + '/cable');
      early.onerror = () => window.order.push('error');
      early.onclose = (e) => window.order.push('close:' + e.code + ':' + e.wasClean);
      early.onopen = () => window.order.push('open');
      early.close();
    JS
    expect(poll_until { session.evaluate_script('window.order.length >= 2 && window.order') }).to eq(['error', 'close:1006:false'])
  end

  # A frame's sockets and sources get their events, as the top window's do; a source's URL is resolved against the
  # document's base URL.
  it 'delivers to a frame\'s socket, and resolves a source against the base URL' do
    session.visit('/framed')
    session.execute_script(<<~JS)
      window.frameWs = new frames[0].WebSocket('ws://' + location.host + '/cable');
      window.frameWs.onmessage = (e) => {
        if (typeof e.data === 'string') {
          window.frameText = [e instanceof frames[0].MessageEvent, e instanceof MessageEvent];
          frameWs.send(new Uint8Array([1, 2]));
        } else {
          window.frameBlob = [e.data instanceof frames[0].Blob, e.data instanceof Blob];
          document.title = 'frame:' + e.data.size;
        }
      };
    JS
    expect(session).to have_title('frame:2')
    # (…the frame's events and data its own realm's)
    expect(session.evaluate_script('[window.frameText, window.frameBlob]')).to eq([[true, false], [true, false]])
    expect(session.evaluate_script("new EventSource('x').url === location.origin + '/sub/dir/x'")).to be(true)
    expect(closes.pop(timeout: 5)).to eq(1001)   # (the first page's, which the visit replaced)
    # A removed frame's socket goes with its document: Going Away.
    session.execute_script("document.querySelector('iframe').remove()")
    expect(closes.pop(timeout: 5)).to eq(1001)
  end

  # What a buffer source is is its internal slots', whatever a page puts on the object or its prototype (a shadowing
  # `byteLength`, a replaced `slice`).
  it 'sends a buffer source by its slots' do
    expect(session).to have_title(/hello/)
    session.execute_script(<<~JS)
      const bytes = new Uint8Array([7, 8, 9]);
      Object.defineProperty(bytes, 'byteLength', {value: 1});
      Uint8Array.prototype.slice = () => new Uint8Array([1]);
      window.ws.send(bytes);
    JS
    expect(session).to have_title('bin:7,8,9')
  end

  # Generated from its IDL: arguments converted, the constructor's and close()'s checks in Chrome's words, the
  # subprotocols compared case-insensitively (the WPT's reading; Chrome takes ['a', 'A']), binaryType an enumeration
  # that ignores what it has not.
  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const ws = new WebSocket('ws://' + location.host + '/other');
        ws.binaryType = 'x';
        return [
          error(() => new WebSocket()),
          error(() => new WebSocket('http://[')),
          error(() => new WebSocket('ftp://x')),
          error(() => new WebSocket('ws://x/#a')),
          error(() => new WebSocket('ws://x/', 'a b')),
          error(() => new WebSocket('ws://x/', ['a', 'a'])),
          error(() => new WebSocket('ws://x/', ['a', 'A'])),
          error(() => ws.send()),
          error(() => ws.send('x')),
          error(() => ws.close(1001)),
          error(() => ws.close(1000, 'x'.repeat(124))),
          error(() => WebSocket.prototype.close.call({})),
          [ws.url === 'ws://' + location.host + '/other', ws.readyState, ws.bufferedAmount, ws.extensions, ws.protocol, ws.binaryType],
          [WebSocket.CONNECTING, WebSocket.prototype.CLOSED],
          error(() => new EventSource()),
          error(() => new EventSource('http://[')),
          [new EventSource('/es', {withCredentials: true}).withCredentials, EventSource.CLOSED],
          error(() => EventSource.prototype.close.call({}))
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to construct 'WebSocket': 1 argument required, but only 0 present.",
      "SyntaxError: Failed to construct 'WebSocket': The URL 'http://[' is invalid.",
      "SyntaxError: Failed to construct 'WebSocket': The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. 'ftp' is not allowed.",
      "SyntaxError: Failed to construct 'WebSocket': The URL contains a fragment identifier ('a'). Fragment identifiers are not allowed in WebSocket URLs.",
      "SyntaxError: Failed to construct 'WebSocket': The subprotocol 'a b' is invalid.",
      "SyntaxError: Failed to construct 'WebSocket': The subprotocol 'a' is duplicated.",
      "SyntaxError: Failed to construct 'WebSocket': The subprotocol 'A' is duplicated.",
      "TypeError: Failed to execute 'send' on 'WebSocket': 1 argument required, but only 0 present.",
      "InvalidStateError: Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
      "InvalidAccessError: Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. 1001 is neither.",
      "SyntaxError: Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.",
      'TypeError: Illegal invocation',
      [true, 0, 0, '', '', 'blob'],
      [0, 3],
      "TypeError: Failed to construct 'EventSource': 1 argument required, but only 0 present.",
      "SyntaxError: Failed to construct 'EventSource': Cannot open an EventSource to 'http://['. The URL is invalid.",
      [true, 2],
      'TypeError: Illegal invocation'
    ])
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
