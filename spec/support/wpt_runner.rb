# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'yaml'
require 'set'
require 'json'
require 'open3'
require 'digest'

# Drives the vendored web-platform-tests (spec/wpt/) through the :simulated
# driver and normalises each file's testharness.js results. Shared by the
# behavioural-conformance gate (spec/wpt_spec.rb) and the allowlist regenerator
# (script/regen_wpt_expected_failures.rb).
#
# Per file the runner: serves spec/wpt/** through a Rack app, visits the test,
# dispatches window 'load' (the driver doesn't auto-fire it), drains the
# virtual clock so the harness completion + any async-test timers run, and
# reads the results our reporter (spec/wpt/resources/testharnessreport.js)
# stashed on `globalThis.__wptResults`.
module WptRunner
  ROOT              = File.expand_path('../wpt', __dir__)
  # The generic WPT `.py` request-handler executor (a minimal wptserve shim).
  PY_HANDLER        = File.expand_path('../../script/wpt_py_handler.py', __dir__)
  EXPECTED_PATH     = File.expand_path('wpt_expected_failures.yml', __dir__)
  OUT_OF_SCOPE_PATH = File.expand_path('wpt_out_of_scope.yml', __dir__)
  SKIP_PATH         = File.expand_path('wpt_skip.yml', __dir__)

  # Sentinel allowlist value for a file whose harness never reaches completion
  # (unsupported include, parse crash, real hang → testharness timeout, …).
  HARNESS_ERROR = 'HARNESS_ERROR'

  # Per-file drain budget. We drain in small virtual-clock steps and stop the
  # instant the harness reports completion — so sync and quick-async tests pay
  # almost nothing. A file with a still-pending test then gets its virtual clock
  # jumped past testharness's own harness-timeout horizon, which fires the
  # `setTimeout(tests.timeout, …)` testharness arms internally and completes the
  # file with every pending subtest marked TIMEOUT. (The global `timeout()` is a
  # no-op unless the file opted into `explicit_timeout`, so it can't be used to
  # force this.) Big virtual jumps are ~free in wall-clock — they only run the
  # few timers actually due — so the suite still runs in seconds.
  # Progress-aware normal drain: pump ONE real-cadence animation frame at a time
  # (`Browser#run_event_loop_frame`) and keep going while the page makes progress, up
  # to a generous frame cap. Each frame runs ALL work ready at the current instant
  # to quiescence (microtasks, due-now timers, render-phase rAF, and the nav /
  # form-submit / worker chains they trigger) and THEN advances ONE frame interval
  # — modelling a real browser. The clock therefore tracks real cadence (~16.67
  # ms/frame) instead of the ~100 ms-per-evaluate_script poll tick the old loop
  # incurred three times per frame (~20× too fast). That matters for files running
  # many sequential rAF `promise_test`s (focus-dynamic-type-change-on-blur: ~80
  # tests × 2 rAF; focus-navigation's double-rAF per Tab hop): their queues drain
  # inside testharness's own 10 s harness timeout, where the old fast clock tripped
  # it after ~30 frames and marked the still-pending tests TIMEOUT. A genuinely
  # idle test (only far-future timers like the harness timeout remain) makes no
  # progress and bails to the force-timeout below within DRAIN_IDLE_BAIL frames; a
  # self-rescheduling animation loop is bounded by DRAIN_MAX_STEPS (then the force
  # jump fires testharness's timeout).
  FRAME_MS           = 16   # ~one 60 Hz animation frame (run_loop_step takes whole ms)
  # Frame cap: FRAME_MS × DRAIN_MAX_STEPS (≈ 10.2 s) lands just past testharness's
  # 10 s harness timeout, which self-completes a still-running normal file first.
  DRAIN_MAX_STEPS    = 640
  # Consecutive no-progress frames → idle → force-timeout. Only ever reached while the harness is
  # still PENDING (the loop breaks the instant `__wptResults` is set), so this bounds "how long a
  # pending-but-apparently-idle page waits before we force testharness's timeout". It must clear the
  # longest INVISIBLE completion chain: a promise_test resolving off a cross-isolate SW message
  # (body → test.done → cleanup=unregister/terminate-worker → next test) progresses over several
  # frames via microtasks + worker-thread wall time with NO DOM / timer / async-channel footprint, so
  # the progress detector can't see it. Under CPU load that chain takes ~4 frames; at the old value of
  # 2 the runner force-timeouted a promise_test one round-trip from completing (postmessage.https
  # transferable-ArrayBuffer subtests flaked [TIMEOUT] under load — see settle_drain memory). 12 gives
  # margin without materially slowing a genuinely-idle page's force-timeout (12 × FRAME_MS ≈ 190 ms,
  # still far below testharness's 10 s harness timeout and the DRAIN_MAX_STEPS cap).
  DRAIN_IDLE_BAIL    = 12
  # A frame with no rAF / async / due-now work still counts as PROGRESS (resets the
  # idle-bail) while a timer is parked within this horizon — a `step_timeout`-style
  # wait the test is deliberately sitting on (e.g. confirming a `scrollend` does NOT
  # fire within 500 ms). Without this the runner declares such a wait idle after
  # DRAIN_IDLE_BAIL frames (~33 ms) and force-timeouts the still-pending test before
  # its wait resolves. The horizon sits above the longest legitimate per-test wait
  # in the corpus (3 s) and below testharness's 10 s normal harness timeout, so a
  # genuinely idle page (only that far-future timeout parked) still bails promptly.
  DRAIN_PENDING_TIMER_HORIZON_MS = 5_000
  FORCE_TIMEOUT_MS   = 12_000  # > the 10 s normal harness timeout (+ margin)
  LONG_TIMEOUT_MS    = 55_000  # cumulative ≈ 67 s > the 60 s `meta timeout=long`
  POST_TIMEOUT_STEPS   = 3   # let a completion that chains through a final
                             # microtask / timer hop land after the jump
  POST_TIMEOUT_STEP_MS = 50  # small virtual step per post-jump settle hop
  DRAIN_ITER         = 5_000
  # `__runLoopStep`'s per-call task cap pins the virtual clock to `limit` only
  # when it runs out of *due* timers — if it hits the iter cap first it returns
  # short of `limit`. The big force jumps must actually reach the harness-timeout
  # horizon, so they get a cap large enough to walk a 1 ms-clamped setInterval
  # across the whole 67 s (≈67 k firings) plus margin.
  FORCE_DRAIN_ITER   = 100_000

  CONTENT_TYPES = {
    '.html' => 'text/html',
    '.htm'  => 'text/html',
    '.xhtml' => 'application/xhtml+xml',
    '.xht'  => 'application/xhtml+xml',
    '.xml'  => 'application/xml',
    '.js'   => 'text/javascript',
    '.json' => 'application/json',
    '.svg'  => 'image/svg+xml',
    '.css'  => 'text/css',
    '.gif'  => 'image/gif',
    '.png'  => 'image/png',
    '.jpg'  => 'image/jpeg',
    '.jpeg' => 'image/jpeg',
    '.bmp'  => 'image/bmp',
    '.webp' => 'image/webp',
    '.avif' => 'image/avif',
    '.mp4'  => 'video/mp4',
    '.webm' => 'video/webm',
    '.ogv'  => 'video/ogg',
    '.ogg'  => 'audio/ogg'   # .ogg is ambiguous; the common meaning is Ogg audio (.ogv is the video ext)
  }.freeze

  # Canonical WPT server identity for `.sub.*` template substitution. wptserve
  # rewrites `{{host}}` / `{{ports[...]}}` / `{{domains[...]}}` / … in `.sub.`
  # files at serve time; we emulate the subset our vendored corpus uses and
  # visit `.sub.` files at this exact host:port (see `run`) so resolved-URL
  # assertions — e.g. innerhtml-mxss's `a.href` — match. Non-`.sub.` files keep
  # the default www.example.com origin, so this is scoped to the `.sub.` set.
  SUB_HOST        = 'web-platform.test'
  SUB_ALT_HOST    = 'not-web-platform.test'
  SUB_HTTP_PORT   = '8000'
  SUB_HTTPS_PORT  = '8443'
  # `ports[http][1]` / `ports[https][1]` — the SECOND port wptserve exposes, a genuinely
  # different origin from port [0]. The in-process app routes by host+path (port is
  # ignored on dispatch), so a distinct port is purely an origin distinction that lets
  # the "same domain, different port" CORS scenarios actually be cross-origin.
  SUB_HTTP_PORT2  = '8001'
  SUB_HTTPS_PORT2 = '8444'
  # WebSocket ports (`ports[ws][0]` / `ports[wss][0]`) — wptserve's defaults. The
  # websockets `.sub.js` files build `ws://{{host}}:{{ports[ws][0]}}/echo`; the in-process
  # app routes WS upgrades by host+path (port ignored on dispatch), so these are just the
  # origin markers the URL carries.
  SUB_WS_PORT     = '8880'
  SUB_WSS_PORT    = '8881'
  SUB_ORIGIN     = "http://#{SUB_HOST}:#{SUB_HTTP_PORT}"
  # wptserve serves a `.https.*` file only over its HTTPS origin (the `.https.`
  # filename marker IS that routing): same canonical host, the https port. A test
  # that reads `get_host_info().HTTPS_ORIGIN` and compares it to its own
  # `location.host` (the cross-partition blob suite) only matches when visited
  # here, and only here does `location.protocol === 'https:'` pick the https ports.
  SUB_HTTPS_ORIGIN = "https://#{SUB_HOST}:#{SUB_HTTPS_PORT}"

  # WPT's universal cross-context message bus (common/dispatcher/dispatcher.js
  # send()/receive()) stores per-uuid FIFO queues in a SERVER-WIDE stash shared
  # across every browsing context and origin — that sharing is the whole point: a
  # popup on one site reads what an opener on another wrote. The vendored
  # dispatcher.py needs wptserve's persistent `request.server.stash`, which our
  # per-request `python3` subprocess can't provide (a fresh process each call sees
  # an empty stash → eternal "not ready"). So back the queue natively in-process.
  # One Rack app serves all origins here, so a single uuid→queue map IS the
  # server-wide stash. Guarded by a mutex (worker threads poll it concurrently).
  DISPATCHER_STASH = Hash.new {|h, k| h[k] = [] }
  DISPATCHER_LOCK  = Mutex.new

  # File-backed request.server.stash for the .py shim (each handler runs in its own
  # subprocess, so cross-request state must live on disk). One dir for the process,
  # cleared per file (run_one) for the same run-order independence the session reset gives.
  require 'tmpdir'
  require 'fileutils'
  STASH_DIR = Dir.mktmpdir('csim-wpt-stash')
  at_exit { FileUtils.remove_entry(STASH_DIR, true) }

  module_function

  # Run a vendored WPT `.py` request handler through script/wpt_py_handler.py (a
  # minimal wptserve shim) via python3, returning a Rack `[status, headers, [body]]`
  # — or nil to fall through (handler missing / python3 unavailable / malformed
  # output) so the caller serves the source as text as before. The request body is
  # piped on stdin; method / URL / headers go via env. Binary-safe: the child emits
  # one JSON metadata line then the raw body bytes.
  def run_py_handler(pyfile, req, env)
    input = env['rack.input']
    body  = input ? input.read.to_s : ''
    input.rewind if input.respond_to?(:rewind)
    # Author-set request headers keep their EXACT names (casing + token chars) via the
    # raw side list browser.rb stashes; the CGI-mangled HTTP_* keys only reconstruct an
    # approximate Title-Case name, so use them solely for the headers NOT in that list
    # (the UA defaults: User-Agent, Host, Accept, …). inspect-headers / echo-headers echo
    # the names verbatim, so the author casing must survive.
    raw     = env['csim.raw_request_headers'] || []
    seen    = raw.map {|name, _| name.downcase }
    headers = raw.map {|name, value| [name, value.to_s] }
    # Skip the HTTP_* env keys that an author header already covers — matched on the
    # MANGLED key (apply_request_headers' upcase + '-'→'_'), since reconstructing the
    # name back can't recover the original (a tchar name's `_` would re-emerge as `-`),
    # so a name-level dedup would wrongly let the mangled twin through as a duplicate.
    covered = raw.map {|name, _|
      m = name.to_s.upcase.tr('-', '_')
      %w[CONTENT_TYPE CONTENT_LENGTH].include?(m) ? m : "HTTP_#{m}"
    }
    env.each do |k, v|
      next unless k.is_a?(String) && k.start_with?('HTTP_')
      next if covered.include?(k)
      headers << [k.sub('HTTP_', '').split('_').map(&:capitalize).join('-'), v.to_s]
    end
    # CONTENT_TYPE / CONTENT_LENGTH live in env without the HTTP_ prefix (CGI
    # convention); a handler that echoes them (content.py's X-Request-Content-Length)
    # needs them forwarded as ordinary headers — unless an author already set them (then
    # they're in the raw list with the author's casing, and re-adding would duplicate).
    headers << ['Content-Type', env['CONTENT_TYPE'].to_s] if env['CONTENT_TYPE'] && !seen.include?('content-type')
    headers << ['Content-Length', env['CONTENT_LENGTH'].to_s] if env['CONTENT_LENGTH'] && !seen.include?('content-length')
    py_env = {
      'WPT_METHOD'   => req.request_method.to_s,
      'WPT_URL'      => req.url.to_s,
      'WPT_HEADERS'  => JSON.generate(headers),
      'WPT_DOC_ROOT' => ROOT,
      # request.server.stash backing dir — shared across a test file's .py subprocesses
      # (the CORS preflight-denied flow stashes state across reset/preflight/complete);
      # cleared per file in run_one.
      'WPT_STASH_DIR' => STASH_DIR,
      'PYTHONDONTWRITEBYTECODE' => '1'   # no __pycache__ in the vendored WPT tree
    }
    out, status = Open3.capture2(py_env, 'python3', PY_HANDLER, pyfile, stdin_data: body, binmode: true)
    return nil unless status.success?
    nl = out.index("\n".b)
    return nil unless nl
    meta  = JSON.parse(out.byteslice(0, nl))
    rbody = out.byteslice(nl + 1, meta['body_len'].to_i) || ''.b
    hdrs = combine_headers(meta['headers'])
    hdrs['content-type'] ||= 'text/plain'
    # A custom HTTP reason phrase (status.py's `status = (code, "text")`) rides an
    # internal header; rack_fetch lifts it into the response's statusText and strips it.
    hdrs['x-csim-status-text'] = meta['status_text'].to_s if meta['status_text']
    [meta['status'].to_i, hdrs, [rbody]]
  rescue StandardError, JSON::ParserError
    nil
  end

  # Collapse an ordered list of [name, value] response-header pairs into Rack's
  # name→value Hash, the way a browser builds the response header list: names
  # lowercased, each value normalized (leading/trailing HTTP whitespace stripped —
  # NOT \v/\f, which headers-some-are-empty preserves), and a field that appears more
  # than once combined with ", " (headers.py's repeated X-Custom-Header-Comma, the
  # `.asis` duplicate-header fixtures). So getResponseHeader sees "1, 2", not "2".
  def combine_headers(pairs)
    Array(pairs).each_with_object({}) do |(name, value), hdrs|
      key = name.to_s.downcase
      val = value.to_s.gsub(/\A[\t\n\r ]+|[\t\n\r ]+\z/, '')
      hdrs[key] = hdrs.key?(key) ? "#{hdrs[key]}, #{val}" : val
    end
  end

  # Parse a vendored `.asis` ("as is") fixture — a raw HTTP response: a status line,
  # header lines (bare-LF in the corpus, duplicates significant), a blank line, then
  # the body. Served verbatim with NO added Content-Type / Date / Server (the point of
  # .asis), so getAllResponseHeaders reflects exactly the listed fields. Returns a Rack
  # `[status, headers, [body]]`.
  def serve_asis(file)
    raw           = File.binread(file)
    head, _, body = raw.partition(/\r?\n\r?\n/)
    lines         = head.split(/\r?\n/)
    status_line   = lines.shift.to_s          # e.g. "HTTP/1.1 280 HELLO"
    code          = (status_line[/\A\S+\s+(\d{3})/, 1] || '200').to_i
    reason        = status_line[/\A\S+\s+\d{3}\s+(.+)/, 1]
    pairs         = lines.filter_map {|l| n, v = l.split(':', 2); [n, v] unless n.to_s.empty? }
    hdrs          = combine_headers(pairs)
    hdrs['x-csim-status-text'] = reason if reason && !reason.empty?
    [code, hdrs, [body]]
  end

  # Emulate wptserve's server-side `{{…}}` substitution for `.sub.` files (the
  # subset our vendored corpus references). `req_path` feeds the `location[...]`
  # tokens. Unknown tokens are left verbatim so a new, unhandled pattern shows
  # up loudly as a literal `{{…}}` in a failing assertion rather than silently
  # mis-substituting to something plausible.
  def substitute(body, req_path, query = {}, host: nil, scheme: 'http')
    # The `{{host}}` / `{{ports}}` / `{{domains}}` / `{{location}}` tokens resolve to the
    # ORIGIN OF THE DOCUMENT fetching this `.sub.` resource — get-host-info.sub.js builds
    # HTTP_ORIGIN from them and a test compares it to its own document origin. So derive
    # them from the requesting Host, not a fixed constant: a `.sub.` test visited at the
    # canonical web-platform.test:8000 keeps that origin (unchanged), while a plain test
    # at www.example.com that pulls in get-host-info.sub.js gets www.example.com origins
    # (so its "same-origin" request is actually same-origin, and HTTP_REMOTE_ORIGIN —
    # `www1.` + host — is genuinely cross-origin). The canonical wptserve host family
    # (web-platform.test / not-web-platform.test) runs on :8000/:8443; every other host
    # (www.example.com) uses the default 80/443 (elided), matching its port-less origin.
    host         = SUB_HOST if host.to_s.empty?
    sub_family   = host == SUB_HOST || host == SUB_ALT_HOST || host.end_with?(".#{SUB_HOST}", ".#{SUB_ALT_HOST}")
    http_port    = sub_family ? SUB_HTTP_PORT   : '80'
    https_port   = sub_family ? SUB_HTTPS_PORT  : '443'
    http_port2   = sub_family ? SUB_HTTP_PORT2  : '81'
    https_port2  = sub_family ? SUB_HTTPS_PORT2 : '444'
    cur_port     = scheme == 'https' ? https_port : http_port
    loc_host     = (scheme == 'https' ? https_port == '443' : http_port == '80') ? host : "#{host}:#{cur_port}"
    alt_host     = sub_family ? SUB_ALT_HOST : "alt.#{host}"
    # File.binread gives ASCII-8BIT; splicing the UTF-8 replacement strings below
    # would raise Encoding::CompatibilityError the moment the body carries any
    # non-ASCII byte. `.sub.` templates are UTF-8 source, so reinterpret as such.
    body.dup.force_encoding('UTF-8').gsub(/\{\{([^}]+)\}\}/) do |whole|
      case Regexp.last_match(1)
      when 'host'                      then host
      when 'ports[http][0]'            then http_port
      when 'ports[http][1]'            then http_port2
      when /\Aports\[http\]\[\d+\]\z/  then http_port
      when 'ports[https][0]'           then https_port
      when 'ports[https][1]'           then https_port2
      when /\Aports\[https\]\[\d+\]\z/ then https_port
      # The WS ports are the SAME for every host (real wptserve runs ws on 8880 / wss on 8881
      # regardless of origin), and deliberately NON-default so `WebSocket#url` keeps the port in
      # its serialization (ws://host:80/ would elide the 80 and the url tests compare the literal).
      when /\Aports\[ws\]\[\d+\]\z/    then SUB_WS_PORT
      when /\Aports\[wss\]\[\d+\]\z/   then SUB_WSS_PORT
      # HTTP/2 has no separate in-process port; the `?wpt_flags=h2` websocket variant only
      # needs a valid wss port to route to the same WS server (scheme/port ignored on dispatch).
      when /\Aports\[h2\]\[\d+\]\z/    then SUB_WSS_PORT
      when 'location[scheme]'          then scheme
      when 'location[host]'            then loc_host
      when 'location[port]'            then cur_port
      when 'location[path]'            then req_path
      when /\Adomains\[(\w*)\]\z/      then (m = Regexp.last_match(1)).empty? ? host : "#{m}.#{host}"
      when /\Ahosts\[alt\]\[(\w*)\]\z/ then (m = Regexp.last_match(1)).empty? ? alt_host : "#{m}.#{alt_host}"
      when /\Ahosts\[\]\[(\w*)\]\z/    then (m = Regexp.last_match(1)).empty? ? host : "#{m}.#{host}"
      # `{{GET[name]}}` → the value of the `name` query parameter (wptserve's
      # request-substitution). Absent params substitute to the empty string, which
      # the form-action tests rely on (`?action=` → an empty action attribute).
      # (A repeated param resolves to Rack's last value; wptserve takes the first.
      # No vendored `.sub.` template references a repeated GET parameter.)
      when /\AGET\[(\w+)\]\z/          then query[Regexp.last_match(1)].to_s
      else whole
      end
    end
  end

  # ── In-process WebSocket server (RFC6455) ───────────────────────────────
  #
  # The websockets/ WPT suite connects to `ws://{{host}}:{{ports[ws][0]}}/<handler>` — paths
  # wptserve maps to `handlers/<handler>_wsh.py` pywebsocket scripts. There's no Python WS
  # server here, so the Rack app answers the upgrade itself: it completes the RFC6455 server
  # handshake on the hijacked socket, then runs a native handler on a background thread — the
  # pywebsocket fixtures re-expressed in Ruby, the same way `dispatcher.py` / `encoding.py`
  # are emulated in `app`. The browser's WebSocket client (Browser#ws_open) already speaks the
  # client half over this same in-process socketpair; the server writes UNmasked frames and
  # reads the client's masked ones (RFC6455 §5.3).
  WS_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

  # One server-side WebSocket connection over the hijacked io: message reassembly + framing.
  class WsConn
    def initialize(io)
      @io = io
    end

    # Next application message, reassembling continuation frames and answering ping inline:
    # `[:text, String]`, `[:binary, bytes]`, `[:close, code_or_nil, reason]`, or nil at EOF.
    def receive
      data   = +''.b
      msg_op = nil
      loop do
        frame = read_frame or return nil
        fin, opcode, payload = frame
        case opcode
        when 0x8
          code   = payload.bytesize >= 2 ? payload.byteslice(0, 2).unpack1('n') : nil
          reason = payload.bytesize > 2 ? payload.byteslice(2..).force_encoding('UTF-8') : ''
          return [:close, code, reason]
        when 0x9 then write_frame(0xA, payload); next   # ping → pong
        when 0xA then next                              # pong → ignore
        when 0x0 then data << payload                   # continuation
        else          msg_op = opcode; data << payload  # 0x1 text / 0x2 binary
        end
        next unless fin

        return msg_op == 0x2 ? [:binary, data] : [:text, data.force_encoding('UTF-8')]
      end
    end

    def send_text(str)   = write_frame(0x1, str.to_s.dup.force_encoding('UTF-8').b)
    def send_binary(b)   = write_frame(0x2, b.to_s.b)
    def send_ping(b = '') = write_frame(0x9, b.to_s.b)
    # Write bytes to the socket WITHOUT framing them — echo_raw injects the client's payload as raw
    # frame bytes to exercise the client's frame parser.
    def write_raw(bytes) = @io.write(bytes.to_s.b)

    # Close handshake: an omitted code sends a bodyless close (RFC6455 §5.5.1).
    def send_close(code = 1000, reason = '')
      payload = code ? [code.to_i].pack('n') + reason.to_s.dup.force_encoding('UTF-8').b : ''.b
      write_frame(0x8, payload)
    end

    private

    def read_frame
      hdr = read_n(2) or return nil
      b0, b1 = hdr.bytes
      fin    = (b0 & 0x80) != 0
      opcode = b0 & 0x0f
      masked = (b1 & 0x80) != 0
      len    = b1 & 0x7f
      if    len == 126 then len = (read_n(2) or return nil).unpack1('n')
      elsif len == 127 then len = (read_n(8) or return nil).unpack1('Q>')
      end
      mask = masked ? (read_n(4) or return nil) : nil
      payload = len.zero? ? ''.b : (read_n(len) or return nil)
      payload = xor(payload, mask) if mask   # client frames are masked; unmask
      [fin, opcode, payload]
    end

    def write_frame(opcode, payload)
      payload = payload.to_s.b
      len     = payload.bytesize
      out     = [0x80 | opcode].pack('C')                       # FIN + opcode; server never masks
      if    len < 126     then out << [len].pack('C')
      elsif len < 65_536  then out << [126, len].pack('Cn')
      else                     out << [127, len].pack('CQ>')
      end
      out << payload
      @io.write(out)
    end

    def read_n(n)
      buf = @io.read(n)
      buf if buf && buf.bytesize == n
    end

    def xor(payload, key)
      kb = key.bytes
      payload.bytes.each_with_index.map {|byte, i| byte ^ kb[i & 3] }.pack('C*')
    end
  end

  # echo_wsh.py — mirror each message back (text→text, binary→binary); on the "Goodbye" text,
  # echo it then start the closing handshake; on a client close, echo its code + reason.
  WS_ECHO = lambda do |conn, _ctx|
    loop do
      msg = conn.receive or break
      case msg[0]
      when :text
        conn.send_text(msg[1])
        if msg[1] == 'Goodbye'
          conn.send_close(1000)
          break
        end
      when :binary then conn.send_binary(msg[1])
      when :close  then conn.send_close(msg[1], msg[2]); break
      end
    end
  end

  # echo_exit_wsh.py / echo_close_data_wsh.py — drain WITHOUT echoing; on "Goodbye" (or the
  # client's close) start the closing handshake, echoing a client-sent code + reason.
  WS_DRAIN_EXIT = lambda do |conn, _ctx|
    loop do
      msg = conn.receive or break
      if    msg[0] == :close                       then conn.send_close(msg[1], msg[2]); break
      elsif msg[0] == :text && msg[1] == 'Goodbye' then conn.send_close(1000); break
      end
    end
  end

  # `handlers/<name>_wsh.py` re-expressed natively. Each entry: `protocol` picks the subprotocol
  # to send back (from the client's `ctx`; nil = none), `run` services the connection given
  # `(WsConn, ctx)`. `ctx` = { requested: [subprotocols], raw_protocol: header, query: raw
  # string, origin: }. Unknown paths fall back to `echo`.
  WS_HANDLERS = {
    'echo'            => {protocol: ->(c) { c[:requested].include?('echo') ? 'echo' : nil }, run: WS_ECHO},
    'echo_exit'       => {run: WS_DRAIN_EXIT},
    'echo_close_data' => {run: WS_DRAIN_EXIT},
    # echo-query_wsh.py — send the raw query string once on open, then close. (`_v13` is the same
    # handler under a pywebsocket protocol-version marker.)
    'echo-query'      => {run: ->(conn, c) { conn.send_text(c[:query]); conn.send_close(1000) }},
    'echo-query_v13'  => {run: ->(conn, c) { conn.send_text(c[:query]); conn.send_close(1000) }},
    # empty-message_wsh.py — the first message must be empty; report pass/fail, then close.
    'empty-message'   => {run: ->(conn, _c) { m = conn.receive; conn.send_text(m && m[0] == :text && m[1] == '' ? 'pass' : 'fail'); conn.send_close(1000) }},
    # protocol_wsh.py — accept the client's requested-protocol header verbatim and send it back.
    'protocol'        => {protocol: ->(c) { c[:raw_protocol].empty? ? nil : c[:raw_protocol] },
                          run: ->(conn, c) { conn.send_text(c[:raw_protocol]); conn.send_close(1000) }},
    # protocol_array_wsh.py — accept the FIRST requested subprotocol and send it back.
    'protocol_array'  => {protocol: ->(c) { c[:requested].first },
                          run: ->(conn, c) { conn.send_text(c[:requested].first.to_s); conn.send_close(1000) }},
    # handshake_protocol_wsh.py — always select `foobar` (the client rejects it unless it offered
    # exactly that); handshake_no_protocol selects none. Both then close immediately (transfer=pass).
    'handshake_protocol'    => {protocol: ->(_c) { 'foobar' }, run: ->(conn, _c) { conn.send_close(1000) }},
    'handshake_no_protocol' => {protocol: ->(_c) { nil },      run: ->(conn, _c) { conn.send_close(1000) }},
    # origin_wsh.py — accept, then send back the request's Origin (the document origin the server saw).
    'origin'          => {run: ->(conn, c) { conn.send_text(c[:origin]); conn.send_close(1000) }},
    # echo-cookie_wsh.py — send back the handshake's Cookie header (or "(none)").
    'echo-cookie'     => {run: ->(conn, c) { conn.send_text(c[:cookie] || '(none)'); conn.send_close(1000) }},
    # set-cookie_wsh.py — set a cookie via a handshake-response header, then keep the connection
    # open until the client closes. (The HttpOnly variant, set-cookie_http, is deliberately NOT
    # handled here: modelling HttpOnly means hiding the cookie from document.cookie while still
    # sending it on requests — a core cookie-jar change with app-suite blast radius. Until that
    # lands, set-cookie_http falls back to echo so it doesn't leak an HttpOnly cookie into
    # document.cookie; cookies/005 stays allowlisted.)
    'set-cookie'      => {extra_headers: ->(c) { ["Set-Cookie: ws_test_#{c[:query]}=test; Path=/"] }, run: WS_DRAIN_EXIT},
    # echo_raw_wsh.py — write each received message's payload back as RAW bytes (unframed), so the
    # payload IS interpreted as frames by the client; stop on the "exit" message.
    'echo_raw'        => {run: lambda do |conn, _c|
      loop do
        msg = conn.receive or break
        break if msg[0] == :close || msg[1] == 'exit' || msg[1] == 'exit'.b
        conn.write_raw(msg[1])
      end
    end},
    # simple_handshake_wsh.py — accept, then immediately do a clean close with code 1001 / "PASS".
    'simple_handshake' => {run: ->(conn, _c) { conn.send_close(1001, 'PASS') }},
    # invalid_wsh.py — write a non-101 garbage response so the opening handshake fails.
    'invalid'         => {raw_handshake: ->(io, _accept, _c) { io.write("FOO BAR BAZ\r\n\r\n") }},
    # wrong_accept_key_wsh.py — a 101 with a bogus Sec-WebSocket-Accept: the client must reject it.
    'wrong_accept_key' => {raw_handshake: lambda do |io, _accept, _c|
      io.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" \
               "Sec-WebSocket-Accept: thisisawrongacceptkey\r\n\r\n")
    end},
  }.freeze

  def websocket_upgrade?(env)
    env['HTTP_UPGRADE'].to_s.downcase == 'websocket' && env['rack.hijack?']
  end

  # Resolve a `/<name>` path to its handler. A path with NO `handlers/<name>_wsh.py` file fails the
  # opening handshake (nil), the way wptserve 404s an unmapped ws path (opening-handshake/006's
  # /invalid1..3). A real handler we haven't re-expressed natively yet falls back to echo so the
  # handshake at least completes (its own test stays allowlisted until the handler lands).
  def ws_handler_for(name)
    return WS_HANDLERS[name] if WS_HANDLERS.key?(name)
    return WS_HANDLERS['echo'] if File.exist?(File.join(ROOT, 'websockets', 'handlers', "#{name}_wsh.py"))

    nil
  end

  # Answer a WS upgrade on the hijacked socket, then service frames on a background thread.
  # Returns a Rack triple (ignored — the connection is hijacked).
  def websocket_serve(env)
    io      = env['rack.hijack'].call
    accept  = Digest::SHA1.base64digest(env['HTTP_SEC_WEBSOCKET_KEY'].to_s + WS_ACCEPT_GUID)
    raw     = env['HTTP_SEC_WEBSOCKET_PROTOCOL'].to_s
    ctx     = {
      requested:    raw.split(',').map(&:strip).reject(&:empty?),
      raw_protocol: raw,
      query:        env['QUERY_STRING'].to_s,
      origin:       env['HTTP_ORIGIN'].to_s,
      cookie:       env['HTTP_COOKIE'],
    }
    name    = env['PATH_INFO'].to_s.sub(%r{\A/}, '').sub(%r{\Ahandlers/}, '').sub(/_wsh\.py\z/, '')
    handler = ws_handler_for(name)
    if handler.nil?
      io.close rescue nil                                       # unmapped path → fail the handshake
      return [101, {}, []]
    end
    if handler[:raw_handshake]
      handler[:raw_handshake].call(io, accept, ctx)             # handler writes its own (maybe bad) response
    else
      chosen = handler[:protocol]&.call(ctx)
      resp = +"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      resp << "Sec-WebSocket-Accept: #{accept}\r\n"
      resp << "Sec-WebSocket-Protocol: #{chosen}\r\n" if chosen && !chosen.empty?
      Array(handler[:extra_headers]&.call(ctx)).each {|h| resp << "#{h}\r\n" }
      resp << "\r\n"
      io.write(resp)
    end
    unless handler[:run]
      io.close rescue nil                                       # no data phase (e.g. a rejected handshake)
      return [101, {}, []]
    end
    Thread.new do
      Thread.current.report_on_exception = false
      handler[:run].call(WsConn.new(io), ctx)
    rescue StandardError
      # connection dropped mid-frame — nothing to recover, just tear down
    ensure
      io.close rescue nil
    end
    [101, {}, []]
  end

  def app
    @app ||= Rack::Builder.new {
      run lambda {|env|
        req  = Rack::Request.new(env)
        path = req.path_info
        # WebSocket upgrade → the in-process RFC6455 server (see WsConn / WS_HANDLERS). The
        # websockets/ suite's `.sub.js` builds `ws://{{host}}:{{ports[ws][0]}}/echo`; the app
        # completes the handshake and services frames on the hijacked socket.
        if WptRunner.websocket_upgrade?(env)
          next WptRunner.websocket_serve(env)
        end
        # `encoding.py?label=X` — WPT's charset CGI. We don't run Python; emulate
        # its one behaviour (echo the label into a `<meta charset>`), which is
        # all the characterSet-normalization tests need. No byte decoding (the
        # body is ASCII).
        if path.end_with?('/encoding.py')
          label = req.params['label'].to_s.gsub('&', '&amp;').gsub('"', '&quot;').gsub('<', '&lt;')
          next [200, {'content-type' => 'text/html'}, [%{<!doctype html><meta charset="#{label}">}]]
        end
        # `dispatcher.py` — WPT's cross-context message bus (see DISPATCHER_STASH).
        # POST appends the body to the uuid queue and returns "done"; GET pops the
        # front (or "not ready" when empty); `show-headers` pushes the request
        # headers as JSON; OPTIONS is the CORS preflight. uuid + flags come from the
        # query string (`req.GET`), so reading them never consumes the POST body.
        if path.end_with?('/dispatcher/dispatcher.py')
          gq   = req.GET
          cors = {
            'access-control-allow-credentials' => 'true',
            'access-control-allow-methods'     => 'OPTIONS, GET, POST',
            'access-control-allow-headers'     => 'Content-Type',
            'access-control-allow-origin'      => (env['HTTP_ORIGIN'] || '*'),
            'cache-control'                    => (gq.key?('cacheable') ? 'max-age=31536000' : 'no-cache, no-store, must-revalidate'),
            'content-type'                     => 'text/plain'
          }
          next [200, cors, ['']] if req.request_method == 'OPTIONS'
          uuid = gq['uuid'].to_s
          ret  = WptRunner::DISPATCHER_LOCK.synchronize do
            queue = WptRunner::DISPATCHER_STASH[uuid]
            if gq.key?('show-headers')
              hdrs = env.select {|k, _| k.start_with?('HTTP_') }
                        .transform_keys {|k| k.sub(/\AHTTP_/, '').downcase.tr('_', '-') }
              queue.push(JSON.generate(hdrs))
              ''
            elsif req.request_method == 'POST'
              input = env['rack.input']
              body  = input ? input.read.to_s : ''
              input.rewind if input.respond_to?(:rewind)
              queue.push(body)
              'done'
            else
              queue.empty? ? 'not ready' : queue.shift
            end
          end
          next [200, cors, [ret]]
        end
        # (redirect.py is no longer special-cased: the real WPT handler runs through
        # the generic .py shim below — it reads the `code`/`location`/`delay`/followed
        # params the old fast-path's `status`-only stub got wrong, e.g. xhr
        # send-redirect's non-followed 300/304/305/306 cases.)
        # `percent-encoding.py` — WPT's URL query/fragment encoder CGI. It
        # base64-decodes the `value` param (UTF-8), emits each code point as a
        # numeric character reference inside `<a href="…?REFS#REFS">`, and serves
        # it as `text/html;charset=<encoding>`. The HTML parser turns the refs back
        # into code points; the driver's URL parser then percent-encodes the query
        # per the document charset (UTF-8 here) and the fragment always as UTF-8.
        if path.end_with?('/percent-encoding.py')
          value    = req.params['value'].to_s.tr(' ', '+')   # undo Rack's +→space
          encoding = req.params['encoding'].to_s
          decoded  = begin
            value.unpack1('m0').force_encoding('UTF-8')
          rescue ArgumentError
            ''
          end
          refs = decoded.each_codepoint.map {|cp| format('&#x%X;', cp) }.join
          # Match percent-encoding.py byte-for-byte: it unconditionally emits
          # `text/html;charset=<encoding>` (the encoding param is always present).
          next [200, {'content-type' => "text/html;charset=#{encoding}"}, [%{<!doctype html>\n<a href="https://doesnotmatter.invalid/?#{refs}##{refs}">test</a>\n}]]
        end
        # `contenttype_setter.py` — WPT's Content-Type CGI (Document-contentType
        # tests). Emulate its behaviour: set Content-Type from type/subtype, with
        # an optional `mime` <meta http-equiv> in the body (a non-authoritative
        # override the response header is meant to win over) and a removeContentType
        # escape. No Python; the driver's contentType reflection is what's tested.
        if path.end_with?('/contenttype_setter.py')
          headers = {'content-type' => 'text/html'}
          type = req.params['type']; subtype = req.params['subtype']
          headers['content-type'] = "#{type}/#{subtype}" if type && subtype
          headers.delete('content-type') if req.params['removeContentType']
          body = String.new('<head>')
          body << %{<meta http-equiv="Content-Type" content="#{req.params['mime']}; charset=utf-8"/>} if req.params['mime']
          body << '</head>'
          next [200, headers, [body]]
        end
        # `form-submission.py` — WPT's form-submission entity-body validator: it
        # checks the POSTed body matches the expected encoding for the enctype and
        # echoes "OK"/"FAIL". We don't run Python; emulate its logic (the
        # submit-entity-body tests POST here from a form inside an iframe and read
        # back "OK"). Content-Type is compared EXACTLY (no charset), matching what
        # the driver sends per enctype.
        if path.end_with?('/form-submission.py')
          qparams = Rack::Utils.parse_query(req.query_string)
          input   = env['rack.input']
          raw     = input ? input.read.to_s : ''
          input.rewind if input.respond_to?(:rewind)
          ctype   = (env['CONTENT_TYPE'] || '').to_s
          ok =
            if qparams['query'] == '1'
              case ctype
              when 'application/x-www-form-urlencoded' then raw == 'foo=bara'
              when 'text/plain'                        then raw == "qux=baz\r\n"
              else
                # multipart/form-data: the first `foo` field must be `bar`.
                boundary = ctype[/boundary=("?)([^";]+)\1/, 2]
                val = nil
                if boundary
                  raw.split("--#{boundary}").each do |part|
                    next unless part =~ /name="foo"/
                    _hdrs, _, body = part.partition("\r\n\r\n")
                    (val = body.sub(/\r\n\z/, '')) && break unless body.empty?
                  end
                end
                val == 'bar'
              end
            elsif qparams.key?('expected_body')
              raw == qparams['expected_body'].to_s
            else
              false
            end
          next [200, {'content-type' => 'text/plain'}, [ok ? 'OK' : 'FAIL']]
        end
        # `echo-content.py` — WPT's request-body echo CGI (the FileAPI
        # send-file-formdata tests POST a multipart body here and assert on the
        # echoed bytes). Emulate it: return the raw request body verbatim as
        # text/plain so the test can compare the serialized multipart structure.
        if path.end_with?('/echo-content.py')
          body = req.body ? req.body.read.to_s : ''
          next [200, {'content-type' => 'text/plain'}, [body]]
        end
        # `echo-content-escaped.py` — like echo-content.py but escapes control /
        # non-ASCII bytes as `\xNN` and doubles backslashes (so a form-target-frame
        # navigation isn't sniffed as a download), restoring CRLF. The FileAPI
        # send-file-form (form-submission) tests read it back from an iframe.
        if path.end_with?('/echo-content-escaped.py')
          raw = (req.body ? req.body.read.to_s : '').b
          out = raw.bytes.map {|byte|
            if byte <= 0x1F || byte >= 0x7F then format('\\x%02x', byte)
            elsif byte == 0x5C              then '\\\\'
            else byte.chr
            end
          }.join.gsub('\\x0d\\x0a', "\r\n")
          next [200, {'content-type' => 'text/plain; charset=UTF-8'}, [out]]
        end
        # `.any.js` / `.window.js` multi-global tests ship only the JS source; WPT
        # generates the per-global HTML wrapper at serve time. Synthesize the
        # window-variant wrapper (`X.any.html` ← `X.any.js`) on request: testharness
        # + report + each `// META: script=` dep + the test source.
        if (m = path.match(%r{\A(/.+\.(?:any|window))\.html\z})) && File.file?(File.expand_path(File.join(WptRunner::ROOT, "#{m[1]}.js")))
          next [200, {'content-type' => 'text/html'}, [WptRunner.any_js_wrapper("#{m[1].sub(%r{\A/}, '')}.js")]]
        end
        # Any other vendored `.py` handler: run it under the minimal wptserve shim
        # (script/wpt_py_handler.py) via python3 instead of serving its source as
        # text. The hardcoded fast-paths above stay (proven + no subprocess); this
        # covers the long tail (echo / set-headers / return-(headers, body)).
        if path.end_with?('.py')
          pyfile = File.expand_path(File.join(WptRunner::ROOT, path))
          if pyfile.start_with?(WptRunner::ROOT + '/') && File.file?(pyfile)
            resp = WptRunner.run_py_handler(pyfile, req, env)
            next resp if resp
          end
        end
        file = File.expand_path(File.join(WptRunner::ROOT, path))
        # wptserve answers a directory request (e.g. GET `/`) with a 200 HTML listing;
        # Document.currentScript's xhr-test gates on status === 200, and responsetype's
        # DONE cases assert the body is non-empty — so serve a minimal non-empty listing.
        if (file == WptRunner::ROOT || file.start_with?(WptRunner::ROOT + '/')) && File.directory?(file)
          next [200, {'content-type' => 'text/html'}, ["<!doctype html>\n<title>Directory listing</title>\n"]]
        end
        unless file.start_with?(WptRunner::ROOT + '/') && File.file?(file)
          next [404, {'content-type' => 'text/plain'}, ['not found']]
        end

        # `.asis` files are raw HTTP responses, served verbatim (status line + the
        # listed headers, no Content-Type added) — the getAllResponseHeaders fixtures.
        next WptRunner.serve_asis(file) if path.end_with?('.asis')

        ct   = WptRunner::CONTENT_TYPES.fetch(File.extname(path).downcase, 'text/plain')
        body = File.binread(file)
        body = WptRunner.substitute(body, path, req.GET, host: req.host, scheme: req.scheme) if File.basename(path).include?('.sub.')
        resp_headers = {'content-type' => ct}
        # wptserve serves a sibling `<file>.headers` as extra response headers
        # (e.g. Last-Modified for document.lastModified). Merge any it declares.
        hdr_file = "#{file}.headers"
        if File.file?(hdr_file)
          File.read(hdr_file).each_line do |line|
            name, val = line.split(':', 2)
            resp_headers[name.strip.downcase] = val.strip if name && val
          end
        end
        # wptserve `?pipe=` response transforms: support the two the corpus uses on a
        # static file — `header(name,value[,append])` (set a response header; the CORS
        # tests inject Access-Control-Allow-Origin this way) and `status(code)`. Other pipe
        # functions (trickle / gzip / slice / …) are ignored. Pipe functions are
        # `|`-separated but a plain `header(a,b)header(c,d)` run also occurs, so scan every
        # `fn(args)`.
        status_code = 200
        req.GET['pipe'].to_s.scan(/(\w+)\(([^)]*)\)/) do |fn, args|
          case fn
          when 'header'
            name, _, rest = args.partition(',')
            name = name.strip.downcase
            next if name.empty?
            if name == 'set-cookie'
              # wptserve `header(name, value, append)`: a trailing `,True`/`,False` is the
              # APPEND flag, NOT part of the value. Set-Cookie is the only corpus header
              # that appends (a response carries several cookies) — accumulate them as an
              # Array (merge_set_cookie already handles a multi-value Set-Cookie) so a
              # second cookie doesn't clobber the first (cors-cookies / credentials/cookies).
              rest = rest[0...rest.rindex(',')] if rest =~ /,\s*(?:True|False)\s*\z/
              resp_headers[name] = Array(resp_headers[name]) + [rest.strip]
            else
              resp_headers[name] = rest.strip
            end
          when 'status' then status_code = args.to_i if args.to_i.positive?
          end
        end
        [status_code, resp_headers, [body]]
      }
    }.to_app
  end

  def session
    # The wptserve shim app serves EVERY host (www.example.com, the cross-origin
    # test hosts not-web-platform.test / www1.web-platform.test, the SUB_ORIGIN),
    # so every host is genuinely local here. Mark it so a cross-origin iframe
    # fixture eager-builds + is served by @app.call (real apps leave this off, so
    # external embeds stay lazy). The Browser caches this at construction, so set
    # the env ONLY while constructing the session and restore it immediately — a
    # process-global flag would otherwise leak into a later non-WPT Browser built
    # in the same rspec process (e.g. under `--order random`).
    @session ||= begin
      prev = ENV['CSIM_LOCAL_ALL_HOSTS']
      ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'
      begin
        Capybara::Session.new(:simulated, app)
      ensure
        if prev.nil? then ENV.delete('CSIM_LOCAL_ALL_HOSTS') else ENV['CSIM_LOCAL_ALL_HOSTS'] = prev end
      end
    end
    # The .py echo handlers (inspect-headers / echo-headers) replay request header
    # names verbatim, which needs the author casing the Rack env's HTTP_* keys lose —
    # opt the Browser into stashing them. WPT-only; real app traffic skips the alloc.
    Capybara::Simulated::Browser.capture_raw_request_headers = true
    @session
  end

  # Every real testharness test file under dom/ — i.e. one that pulls in
  # testharness.js. Reference / manual / support / resources files are not
  # tests and are skipped. Files on the skip list (driver crashers — see
  # `skip`) are excluded here so they neither run nor need an allowlist entry.
  # Top-level trees + the narrow html/ subtrees we vendor: the event-loop oracle
  # (timers + microtask-queuing) and the forms semantics surface (form
  # submission / constraint validation / input / select / textarea / labels —
  # the form-driven slice every app suite exercises) + custom-elements (the CE
  # lifecycle — define / upgrade / reactions / form-associated — that Turbo and Web
  # Component apps ride on), plus css/cssom (the pure-API
  # CSSOM object model, backed by our css-tree cascade engine — css/cssom-view is
  # the layout-dependent tree and is deliberately not vendored). service-workers holds
  # the vendored service-worker tree (registration / lifecycle / messaging / fetch
  # interception against the real SW runtime) plus committed local `csim-*` fixtures
  # (vendor_wpt.mjs's cleanTree preserves the prefix). Keep this list in sync with the
  # vendor manifest in script/vendor_wpt.mjs.
  TREES = '{dom,domparsing,url,encoding,shadow-dom,FileAPI,html/dom,html/webappapis/timers,html/webappapis/microtask-queuing,html/webappapis/scripting/events,html/semantics/forms,custom-elements,html/webappapis/atob,html/webappapis/structured-clone,webmessaging,input-events,xhr,fetch/api,fetch/data-urls,fetch/h1-parsing,css/cssom,html/canvas/element,service-workers,websockets,webstorage,WebCryptoAPI}'

  # `.any.js` / `.window.js` trees safe to scan: url/ + encoding/ + the html/
  # event-loop oracle + xhr/ + html/dom/ + html/semantics/forms/ + atob/
  # structured-clone + the fetch/ request slice (api/data-urls/h1-parsing) +
  # service-workers/cache-storage/ (Cache Storage API — swept crasher-free save
  # cache-abort, which streams an unbounded body and is on the skip list) — each was
  # swept per-file with a hang timeout and found crasher-free (xhr 86, html/dom+forms
  # 26, fetch+atob+structured-clone 145: 0 hangs). The top-level dom/ tree's 34
  # `.any.js`/`.window.js` (abort / events / nodes / traversal) were swept per-file
  # under a hard `timeout -s KILL` and found crasher-free — the earlier
  # infinite-loop concern was in dom/ HTML files, not this JS slice. (.tentative
  # files auto-route to out-of-scope, so a tentative window.js here self-excludes.)
  JS_TREES = '{dom,url,encoding,FileAPI,html/webappapis/timers,html/webappapis/microtask-queuing,html/webappapis/scripting/events,xhr,html/dom,html/semantics/forms,custom-elements,html/webappapis/atob,html/webappapis/structured-clone,webmessaging,input-events,fetch/api,fetch/data-urls,fetch/h1-parsing,service-workers/cache-storage,webstorage,websockets,WebCryptoAPI}'

  def test_files
    @test_files ||= begin
      html = Dir.glob("#{TREES}/**/*.{html,htm,xhtml,xht}", base: ROOT).reject {|rel|
        rel.end_with?('-ref.html', '-manual.html', '-notref.html', '-ref.xhtml', '-manual.xhtml') ||
          (rel.split('/') & %w[support resources reftest]).any? ||
          skipped?(rel)
      }.select {|rel|
        File.read(File.join(ROOT, rel)).include?('/resources/testharness.js')
      }
      # `.any.js` / `.window.js` multi-global tests (run via the synthesized
      # window-variant wrapper, see `app` / `any_js_wrapper`); scope = JS_TREES.
      js = Dir.glob("#{JS_TREES}/**/*.{any,window}.js", base: ROOT).reject {|rel|
        (rel.split('/') & %w[support resources]).any? || skipped?(rel)
      }
      (html + js).sort
    end
  end

  # Synthesize the window-variant HTML wrapper for a `.any.js` / `.window.js`
  # test: testharness + report, each `// META: script=…` dependency (resolved
  # relative to the test file, or absolute from the WPT root), then the test
  # source itself. Mirrors what wptserve generates.
  def any_js_wrapper(js_rel)
    src  = File.read(File.join(ROOT, js_rel))
    dir  = File.dirname(js_rel)
    deps = src.each_line.take_while {|l| l.start_with?('//') || l.strip.empty? }
              .filter_map {|l| l[%r{//\s*META:\s*script=(\S+)}, 1] }
    tags = deps.map {|d|
      url = d.start_with?('/') ? d : File.expand_path(d, '/' + dir)   # resolve relative to the test's dir
      %{<script src="#{url}"></script>}
    }
    <<~HTML
      <!doctype html><meta charset="utf-8">
      <script src="/resources/testharness.js"></script>
      <script src="/resources/testharnessreport.js"></script>
      <script>
        // The `GLOBAL` scope-probe wptserve injects into every multi-global wrapper
        // (tests branch on window vs worker via it). This is the window variant.
        self.GLOBAL = {
          isWindow:      function () { return true; },
          isWorker:      function () { return false; },
          isShadowRealm: function () { return false; }
        };
      </script>
      #{tags.join("\n")}
      <script src="/#{js_rel}"></script>
    HTML
  end

  # Files excluded from the run entirely because they crash or pathologically
  # hang the driver (deep-recursion stack overflow, runaway dispatch, …) rather
  # than merely producing wrong subtest results. This is the driver-crasher
  # backlog, kept separate from the per-subtest allowlist (wrong-behaviour
  # backlog). Maps relpath => reason. Shrinking it means fixing a driver crash.
  def skip
    @skip ||= File.exist?(SKIP_PATH) ? (YAML.safe_load_file(SKIP_PATH) || {}) : {}
  end

  # Skip-list keys ending in `/` are directory prefixes — they skip a
  # whole subtree in one entry (used for structural non-goals like the
  # legacy multi-byte encoding trees, which are thousands of exhaustive
  # data-driven subtests we deliberately don't decode).
  def skip_prefixes
    @skip_prefixes ||= skip.keys.select {|k| k.end_with?('/') }
  end

  def skipped?(rel)
    skip.key?(rel) || skip_prefixes.any? {|p| rel.start_with?(p) }
  end

  # Run a test file. Returns a Hash:
  #   { completed: true,  failing: ["subtest name", …] }   # harness finished
  #   { completed: false, error: "…" | nil }               # never completed
  #
  # A file declaring `<meta name=variant>` / `// META: variant=` is run ONCE PER
  # VARIANT (the way WPT itself executes it), with each variant's query string
  # appended to the URL; the subtest results are MERGED under the bare `rel` key
  # so the allowlists stay keyed by file, not by variant. A variant query either
  # PARTITIONS a data-driven test's cases (?include= / ?exclude= / ?N-M — the
  # union equals the no-query run) or SELECTS a mode (?mode=open) the no-query run
  # would otherwise miss. A file with no variants runs once (the no-query URL).
  # If any variant fails to complete, the whole file is reported not-completed.
  def run(rel)
    variants = variant_queries(rel)
    return run_one(rel) if variants.empty?
    merged       = []
    merged_tests = []
    variants.each do |q|
      r = run_one(rel, q)
      return {completed: false, error: r[:error]} unless r[:completed]
      merged.concat(r[:failing])
      merged_tests.concat(r[:tests])
    end
    {completed: true, failing: merged, tests: merged_tests}
  end

  # A file's declared variant query strings: `<meta name=variant content="?…">`
  # (HTML) or `// META: variant=?…` (`.any.js` / `.window.js`). Empty → no variants.
  def variant_queries(rel)
    path = File.join(ROOT, rel)
    return [] unless File.file?(path) && File.size(path).positive?
    head = File.read(path, 65536).to_s
    qs = if rel.end_with?('.any.js', '.window.js')
      head.scan(%r{^\s*//\s*META:\s*variant=(\S+)}).flatten
    else
      head.scan(/<meta\s+name=["']?variant["']?\s+content=["']([^"']*)["']/i).flatten
    end
    qs.map(&:strip).reject(&:empty?)
  rescue StandardError
    []
  end

  # Run a SINGLE (rel, variant-query) pair. `query` is '' for a no-variant file.
  def run_one(rel, query = '')
    # `.sub.` files are served with wptserve `{{…}}` substitution and visited at
    # the canonical wptserve origin so their substituted host:port matches the
    # document origin (resolved-URL assertions depend on it). Crossing origins on
    # the shared session leaves the *next* file's harness unable to complete, so
    # isolate `.sub.` runs behind a fresh session on both sides — cheap (a handful
    # of files) and keeps every other file on the stable www.example.com path.
    base    = File.basename(rel)
    sub     = base.include?('.sub.')
    # `.https.` files are served at the canonical HTTPS origin (see SUB_HTTPS_ORIGIN);
    # `.sub.` files at the canonical HTTP origin. Both cross origin off the default
    # www.example.com, so isolate them behind a fresh session on each side.
    https   = base.include?('.https.')
    cross   = sub || https
    drop_session! if cross
    s = session
    # Full per-file reset — what Capybara runs between tests, which this long-lived
    # WPT session bypasses (it memoizes ONE session for the whole suite). It gives each
    # file the fresh browsing context real WPT's per-file isolation provides, two parts
    # of which are load-bearing here:
    #   - History clearing — otherwise a test that calls `history.back()`
    #     (select-restore-invalid-option's bfcache round-trip, the selectedcontent-
    #     restore files, …) traverses the SHARED history back into the PREVIOUS file's
    #     document, re-runs its testharness, and reports THAT file's results, making the
    #     gate depend on visit order.
    #   - Thread teardown — browser.reset! KILLS the web worker / SSE / websocket
    #     threads a file spawned, and reset_windows! disposes its aux windows. Left
    #     running, each file's background V8 isolates pile into V8Runtime's process-wide
    #     @@live and are only reclaimed by the at_exit hook; on a 1900-file suite that
    #     means disposing hundreds of thread-confined isolates at once and deadlocking,
    #     so the process takes MINUTES to exit after the last example.
    # The immediately-following visit rebuilds the page either way.
    s.driver.reset!
    # The dispatcher message bus is the one cross-file channel; clear it per file so a
    # message left queued by a prior file's contexts can't leak into this one (uuids
    # are random so a collision is unreachable today, but this keeps the same
    # run-order independence the history/session resets enforce, and bounds the map).
    DISPATCHER_LOCK.synchronize { DISPATCHER_STASH.clear }
    # Per-file reset of the file-backed server.stash (same run-order independence).
    FileUtils.rm_f(Dir.glob(File.join(STASH_DIR, '*')))
    # `.any.js` / `.window.js` tests run through their synthesized HTML wrapper;
    # a variant query (if any) is appended to the visited URL.
    visit = rel.end_with?('.any.js', '.window.js') ? rel.sub(/\.js\z/, '.html') : rel
    visit = "#{visit}#{query}"
    origin = sub ? SUB_ORIGIN : (https ? SUB_HTTPS_ORIGIN : nil)
    s.visit(origin ? "#{origin}/#{visit}" : "/#{visit}")
    # The driver doesn't auto-fire window 'load'; testharness completes its
    # sync tests off that event (then a setTimeout(0) sets `all_loaded`). Prefer
    # the bridge's `__csimFireWindowLoad`, which uses a module-captured `Event`
    # constructor — a test that does `delete window.Event` (interface-objects.html)
    # would otherwise make `new Event('load')` throw and the harness never finish.
    s.evaluate_script(
      "typeof __csimFireWindowLoad === 'function' ? __csimFireWindowLoad() : window.dispatchEvent(new Event('load'))"
    )

    res = nil
    idle = 0
    DRAIN_MAX_STEPS.times do
      # Advance the page one real-cadence event-loop frame (quiescence at the
      # current instant, then one frame interval). Advancing the clock by one frame
      # — not the ~100 ms-per-evaluate_script poll tick the old loop incurred three
      # times per frame — keeps virtual time at a real browser's cadence (see
      # FRAME_MS / Browser#run_event_loop_frame). Then check OUR completion sentinel
      # (the reporter's `__wptResults`) with a clock-free `peek_script`, so polling
      # it each frame doesn't perturb the cadence the loop maintains.
      frame = s.driver.run_event_loop_frame(FRAME_MS)
      # Read OUR completion sentinel (the reporter's `__wptResults`) with the same
      # clock-free `peek_script` — returns the results object once set, nil before —
      # so polling it each frame doesn't perturb the cadence the loop maintains.
      res = s.driver.peek_script('globalThis.__wptResults')
      break unless res.nil?
      # Progress = this frame did work, or an rAF / async channel is still in
      # flight (a freshly-spawned worker that hasn't posted yet, SSE, a hijacked
      # fetch), or a near-future timer is parked (a `step_timeout`-style wait the
      # test is sitting on — see DRAIN_PENDING_TIMER_HORIZON_MS). No progress for
      # DRAIN_IDLE_BAIL consecutive frames → idle → stop and let the force-timeout
      # below fire it. (`next_timer` is always a Float; -1 means no timer queued.)
      nt = frame['next_timer']
      pending_timer = nt >= 0 && nt <= DRAIN_PENDING_TIMER_HORIZON_MS
      if frame['progressed'] || frame['raf'] || frame['async'] || pending_timer
        idle = 0
        # An async channel in flight is usually a WORKER thread. The drain loop
        # otherwise spins holding the GVL, starving that thread; yield briefly so
        # it makes progress deterministically (otherwise its first postMessage
        # lands non-deterministically — a flaky SharedWorker connect, etc.).
        sleep(0.001) if frame['async']
      else
        idle += 1
        break if idle >= DRAIN_IDLE_BAIL
      end
    end

    if res.nil?
      # Still-pending test(s): jump the virtual clock past testharness's harness
      # timeout so its internal `setTimeout(tests.timeout, …)` fires, marking
      # every pending subtest TIMEOUT and completing the file. Two cumulative
      # jumps cover the 10 s normal and 60 s `<meta name=timeout content=long>`
      # horizons; we stop at the first one that completes.
      [FORCE_TIMEOUT_MS, LONG_TIMEOUT_MS].each do |jump|
        s.evaluate_script("typeof __drainTimers === 'function' ? __drainTimers(#{jump}, #{FORCE_DRAIN_ITER}) : null")
        res = s.evaluate_script('globalThis.__wptResults')
        break unless res.nil?
      end
      # Let a completion that chains through a final microtask / timer hop land.
      POST_TIMEOUT_STEPS.times do
        break unless res.nil?
        s.evaluate_script("typeof __drainTimers === 'function' ? __drainTimers(#{POST_TIMEOUT_STEP_MS}, #{DRAIN_ITER}) : null")
        res = s.evaluate_script('globalThis.__wptResults')
      end
    end

    return {completed: false, error: nil} if res.nil?

    # Full per-subtest detail (name / status / message) is kept on `tests`; the
    # gate only consumes `failing` (the non-PASS names), but `wpt_diag` and any
    # other diagnostic surfaces the messages the gate discards.
    tests   = res['tests']
    failing = tests.reject {|t| t['status'].to_i.zero? }.map {|t| t['name'] }
    {completed: true, failing: failing, tests: tests}
  rescue StandardError => e
    # A file that errored may have left the shared session in a bad state;
    # rebuild it so the next file (and the result) doesn't depend on run order.
    drop_session!
    {completed: false, error: e.message}
  ensure
    # Drop the cross-origin session so the next (default-origin) file starts fresh
    # on www.example.com — see the `cross` isolation note above. `drop_session!`
    # fully disposes it (aux windows AND the primary isolate): a dropped session is
    # never reset_windows!'d by the next file, so otherwise its isolates + threads
    # leak to at_exit — one primary V8 isolate per cross-origin file, hundreds over
    # the suite, which on canvas's pixel-buffer-heavy isolates is GBs of RSS.
    drop_session! if cross
  end

  # Drop the memoized session, fully disposing its driver first (aux windows +
  # primary V8 isolate) so nothing leaks into V8Runtime's process-wide `@@live`.
  def drop_session!
    (@session.driver.dispose rescue nil) if @session
    @session = nil
  end

  # The behavioural-conformance allowlist is split across two files: the in-scope
  # backlog (wpt_expected_failures.yml — bare name lists, the roadmap) and the
  # earned out-of-scope failures (wpt_out_of_scope.yml — {name, reason} lists, a
  # deliberate non-goal per CLAUDE.md rule 1). The gate is symmetric over the
  # UNION: a non-PASS subtest listed in NEITHER turns red, and a listed subtest
  # that now passes turns red regardless of which file it's in. `expected` returns
  # that merged view per file — a name multiset, or the HARNESS_ERROR sentinel.
  def expected
    @expected ||= begin
      in_map  = load_yaml_map(EXPECTED_PATH)
      out_map = out_of_scope
      (in_map.keys | out_map.keys).each_with_object({}) do |rel, merged|
        iv = in_map[rel]
        out_names = out_subtest_names(rel)
        # HARNESS_ERROR is a whole-file sentinel (the harness never completed). It
        # may be listed in EITHER file — in-scope (a gap to fix) or out-of-scope
        # (an earned non-goal, e.g. a target=_blank test that hangs without a real
        # multi-window model), the latter as a single {name: HARNESS_ERROR} entry.
        merged[rel] = (iv == HARNESS_ERROR || out_names.include?(HARNESS_ERROR)) ? HARNESS_ERROR : Array(iv) + out_names
      end
    end
  end

  # Raw out-of-scope map: rel => [{ 'name' =>, 'reason' => }, …]. Exposed so the
  # regen script can preserve each kept entry's reason across regenerations.
  def out_of_scope
    @out_of_scope ||= load_yaml_map(OUT_OF_SCOPE_PATH)
  end

  # Out-of-scope subtest names for a file, with multiplicity (reasons dropped).
  def out_subtest_names(rel)
    Array(out_of_scope[rel]).map {|e| e.is_a?(Hash) ? e['name'] : e }
  end

  # Reason tag marking a WICG / pre-standard out-of-scope entry. Such an entry is
  # excused like a `.tentative` test, but its path carries no ratification signal.
  WICG_REASON_TAG = '[WICG]'

  # WICG out-of-scope entries that may have STANDARDIZED. A `.tentative` test signals
  # ratification by losing its suffix (the path changes → it re-enters as a fresh
  # in-scope failure); a WICG-tagged entry with an ordinary filename can't. So judge by
  # the test's own `<link rel=help>`: when none of its help links reference WICG anymore,
  # the proposal has likely moved to a standards body — surface it for re-audit (the
  # self-healing analogue). Returns rel => [help hrefs] for each drifted entry.
  def wicg_drift
    out_of_scope.each_with_object({}) do |(rel, entries), drift|
      next unless Array(entries).any? {|e| e.is_a?(Hash) && e['reason'].to_s.include?(WICG_REASON_TAG) }
      path = File.join(ROOT, rel)
      next unless File.exist?(path)
      helps = File.read(path).scan(/<link\b[^>]*>/i)
                  .select {|tag| tag.match?(/\brel\s*=\s*["']?[^"'>]*\bhelp\b/i) }
                  .filter_map {|tag| tag[/\bhref\s*=\s*["']([^"']+)["']/i, 1] }
      next if helps.empty?                          # no help link to judge by — leave it
      next if helps.any? {|h| h.match?(/wicg/i) }   # still references WICG → still pre-standard
      drift[rel] = helps
    end
  end

  def load_yaml_map(path)
    File.exist?(path) ? (YAML.safe_load_file(path) || {}) : {}
  end

  # Multiset difference: the elements of `a` left over after removing one
  # occurrence per element of `b`. Used so duplicate subtest names (WPT loop /
  # generated tests reuse names) are compared with multiplicity — `Array#-`
  # would collapse `["X","X"] - ["X"]` to `[]` and hide a second same-named
  # failure.
  def multiset_minus(a, b)
    counts = b.tally
    a.reject {|x| counts[x].to_i.positive? && counts[x] -= 1 }
  end
end
