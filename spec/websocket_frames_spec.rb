# frozen_string_literal: true

require 'digest'
require 'io/wait'
require 'capybara/simulated'
require_relative 'support/session_teardown'

# What a WebSocket client makes of the frames its server writes (RFC 6455 §5, ws_frame.rs): a message's fragments
# joined around a control frame between them, and the connection FAILED — an `error`, then a `close` of 1006, not clean,
# and no message — on a frame the protocol forbids, the server sent a Close of 1002 first (RFC 6455 §7.1.7). Measured
# 2026-11-26 against a server writing the same frames by hand: Chrome fails every one of these, with that Close; Firefox
# fails all but the Close frame's (it closes a lone-byte body and the reserved codes 1005, 1006 and 1015 cleanly), sends
# no Close, and hands the page a masked frame's message before it fails. A Close of any other code, assigned or not (999,
# 1004, 2999, 5000…), closes cleanly in both.
RSpec.describe 'WebSocket frames' do
  # A server's frame: final unless `fin: false`, unmasked unless `mask`, `rsv` its reserved bits.
  def self.frame(opcode, payload = ''.b, fin: true, mask: nil, rsv: 0)
    payload = payload.b
    out = [(fin ? 0x80 : 0) | rsv | opcode].pack('C')
    bit = mask ? 0x80 : 0
    out << (payload.bytesize < 126 ? [bit | payload.bytesize].pack('C') : [bit | 126, payload.bytesize].pack('Cn'))
    return out << payload unless mask

    out << mask << payload.bytes.each_with_index.map {|b, i| b ^ mask.getbyte(i & 3) }.pack('C*')
  end

  # The frames of each case (a class method, not a constant: one in a describe block is top-level).
  def self.cases = @cases ||= {
    'joined'        => frame(0x1, 'he', fin: false) + frame(0x9, 'p') + frame(0x0, 'llo') + frame(0x8, [1000].pack('n') + 'bye'),
    'masked'        => frame(0x1, 'hi', mask: 'abcd'),
    'reserved_bit'  => frame(0x1, 'hi', rsv: 0x40),
    'reserved_op'   => frame(0x3, ''),
    'long_ping'     => frame(0x9, 'x' * 126),
    'fragmented'    => frame(0x9, 'p', fin: false),
    'continuation'  => frame(0x0, 'x'),
    'interleaved'   => frame(0x1, 'a', fin: false) + frame(0x1, 'b'),
    'not_utf8'      => frame(0x1, "a\xFFb".b),
    'one_byte'      => frame(0x8, 'x'),
    'reserved_code' => frame(0x8, [1005].pack('n')),
    'server_close'  => frame(0x8, [4001].pack('n') + 'x'),
    'odd_code'      => frame(0x8, [2999].pack('n') + 'r'),
    'bare_close'    => frame(0x8),
    # (…none of its own: it answers the client's Close with its own)
    'client_close'  => ''.b
  }.freeze

  # A client's frame, unmasked: [opcode, payload] — nil where none comes in time.
  def self.client_frame(io)
    return unless io.wait_readable(2) && (head = io.read(2))

    len = head.getbyte(1) & 0x7f
    len = io.read(2).unpack1('n') if len == 126
    key = io.read(4)
    [head.getbyte(0) & 0x0f, (io.read(len) || ''.b).bytes.each_with_index.map {|b, i| b ^ key.getbyte(i & 3) }.pack('C*')]
  rescue IOError, SystemCallError
    nil
  end

  # The handshakes' request headers, as the app saw them; and the frames each case's client sent, by its name.
  let(:handshakes) { [] }
  let(:sent) { Hash.new {|h, k| h[k] = Thread::Queue.new } }
  let(:app) {
    cases = self.class.cases
    handshakes = self.handshakes
    sent = self.sent
    group = self.class
    lambda {|env|
      if env['HTTP_UPGRADE'].to_s.casecmp?('websocket')
        handshakes << env.select {|k, _| k.start_with?('HTTP_') }
        accept = Digest::SHA1.base64digest(env['HTTP_SEC_WEBSOCKET_KEY'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        io = env['rack.hijack'].call
        io.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: #{accept}\r\n\r\n")
        name = env['QUERY_STRING']
        io.write(cases.fetch(name))
        Thread.new do
          while (f = group.client_frame(io))
            sent[name] << f
            io.write(group.frame(0x8, f[1])) if name == 'client_close' && f[0] == 0x8
          end
          sent[name].close
        end
        [101, {}, []]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset="utf-8"><title>t</title>
          <script>
            window.seen = {};
            window.run = (name) => {
              const events = seen[name] = [];
              const ws = new WebSocket('ws://' + location.host + '/ws?' + name);
              ws.onopen = () => { events.push('open'); if (name === 'client_close') ws.close(4000, 'me'); };
              ws.onmessage = (e) => events.push('message:' + e.data);
              ws.onerror = () => events.push('error');
              ws.onclose = (e) => events.push(['close', e.code, e.wasClean, e.reason].join(':'));
            };
          </script>
        HTML
      end
    }
  }
  let(:session) { simulated_session(app) }
  before { session.visit('/') }

  def events_of(name)
    session.execute_script("run(#{name.to_json})")
    session.document.synchronize { session.evaluate_script("seen[#{name.to_json}]").tap {|e| raise Capybara::ExpectationNotMet unless e.last.to_s.start_with?('close') } }
  end

  it "joins a message's fragments around a control frame between them" do
    expect(events_of('joined')).to eq(['open', 'message:hello', 'close:1000:true:bye'])
  end

  # Its opening handshake as Fetch makes the request (WebSockets "establish a WebSocket connection"): the `Accept` of no
  # destination, its cache mode `no-store`'s `Pragma` / `Cache-Control`, its Fetch Metadata (mode `websocket`), its
  # client's origin, and no `Referer` — its referrer is `no-referrer`. (Firefox sends the same Accept and Fetch
  # Metadata, measured 2026-11-26; neither it nor Chrome a Referer.)
  it 'opens with the request Fetch makes of it' do
    events_of('joined')
    expect(handshakes.last).to include(
      'HTTP_ACCEPT'         => '*/*',
      'HTTP_PRAGMA'         => 'no-cache',
      'HTTP_CACHE_CONTROL'  => 'no-cache',
      'HTTP_SEC_FETCH_DEST' => 'empty',
      'HTTP_SEC_FETCH_MODE' => 'websocket',
      'HTTP_SEC_FETCH_SITE' => 'same-origin',
      'HTTP_ORIGIN'         => session.evaluate_script('location.origin')
    )
    expect(handshakes.last).not_to have_key('HTTP_REFERER')
  end

  # RFC 6455 §5.5.1: a Close frame received where none was sent is answered with one — echoing its code and reason, as
  # Chrome and Firefox do (measured 2026-11-26), a bare one with a bare one — and one sent first is the only one sent.
  def frames_sent(name)
    queue = sent[name]
    frames = []
    while (f = queue.pop(timeout: 3))
      frames << f
    end
    frames
  end

  it "answers a server's Close with its own, echoing its code and reason" do
    expect(events_of('server_close')).to eq(['open', 'close:4001:true:x'])
    expect(frames_sent('server_close')).to eq([[0x8, [4001].pack('n') + 'x']])
    expect(events_of('bare_close')).to eq(['open', 'close:1005:true:'])
    expect(frames_sent('bare_close')).to eq([[0x8, ''.b]])
  end

  it 'sends no second Close where its own came first' do
    expect(events_of('client_close')).to eq(['open', 'close:4000:true:me'])
    expect(frames_sent('client_close')).to eq([[0x8, [4000].pack('n') + 'me']])
  end

  it 'closes cleanly on a Close of an unassigned code' do
    expect(events_of('odd_code')).to eq(['open', 'close:2999:true:r'])
  end

  (cases.keys - ['joined', 'server_close', 'bare_close', 'client_close', 'odd_code']).each do |name|
    it "fails the connection on a frame the protocol forbids, telling the server: #{name.tr('_', ' ')}" do
      expect(events_of(name)).to eq(['open', 'error', 'close:1006:false:'])
      # (…a Close of 1002, a protocol error, and why)
      expect(frames_sent(name)).to match([[0x8, satisfy {|body| body.unpack1('n') == 1002 && body.bytesize > 2 }]])
    end
  end
end
