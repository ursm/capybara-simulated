# frozen_string_literal: true

require 'digest'
require 'capybara/simulated'
require_relative 'support/session_teardown'

# What a WebSocket client makes of the frames its server writes (RFC 6455 §5, ws_frame.rs): a message's fragments
# joined around a control frame between them, and the connection FAILED — an `error`, then a `close` of 1006, not clean,
# and no message — on a frame the protocol forbids. Measured 2026-11-26 against a server writing the same frames by hand:
# Chrome fails every one of these; Firefox fails all but the Close frame's (it closes a lone-byte body and a 1005 code
# cleanly) and hands the page a masked frame's message before it fails.
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
    'reserved_code' => frame(0x8, [1005].pack('n'))
  }.freeze

  # The handshakes' request headers, as the app saw them.
  let(:handshakes) { [] }
  let(:app) {
    cases = self.class.cases
    handshakes = self.handshakes
    lambda {|env|
      if env['HTTP_UPGRADE'].to_s.casecmp?('websocket')
        handshakes << env.select {|k, _| k.start_with?('HTTP_') }
        accept = Digest::SHA1.base64digest(env['HTTP_SEC_WEBSOCKET_KEY'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        io = env['rack.hijack'].call
        io.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: #{accept}\r\n\r\n")
        io.write(cases.fetch(env['QUERY_STRING']))
        [101, {}, []]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset="utf-8"><title>t</title>
          <script>
            window.seen = {};
            window.run = (name) => {
              const events = seen[name] = [];
              const ws = new WebSocket('ws://' + location.host + '/ws?' + name);
              ws.onopen = () => events.push('open');
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

  (cases.keys - ['joined']).each do |name|
    it "fails the connection on a frame the protocol forbids: #{name.tr('_', ' ')}" do
      expect(events_of(name)).to eq(['open', 'error', 'close:1006:false:'])
    end
  end
end
