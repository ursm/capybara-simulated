# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'yaml'
require 'set'
require 'json'
require 'open3'

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
  DRAIN_IDLE_BAIL    = 2    # consecutive no-progress frames → idle → force-timeout
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
    '.webp' => 'image/webp'
  }.freeze

  # Canonical WPT server identity for `.sub.*` template substitution. wptserve
  # rewrites `{{host}}` / `{{ports[...]}}` / `{{domains[...]}}` / … in `.sub.`
  # files at serve time; we emulate the subset our vendored corpus uses and
  # visit `.sub.` files at this exact host:port (see `run`) so resolved-URL
  # assertions — e.g. innerhtml-mxss's `a.href` — match. Non-`.sub.` files keep
  # the default www.example.com origin, so this is scoped to the `.sub.` set.
  SUB_HOST       = 'web-platform.test'
  SUB_ALT_HOST   = 'not-web-platform.test'
  SUB_HTTP_PORT  = '8000'
  SUB_HTTPS_PORT = '8443'
  SUB_ORIGIN     = "http://#{SUB_HOST}:#{SUB_HTTP_PORT}"

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
    headers = []
    env.each do |k, v|
      next unless k.is_a?(String) && k.start_with?('HTTP_')
      headers << [k.sub('HTTP_', '').split('_').map(&:capitalize).join('-'), v.to_s]
    end
    headers << ['Content-Type', env['CONTENT_TYPE'].to_s] if env['CONTENT_TYPE']
    py_env = {
      'WPT_METHOD'   => req.request_method.to_s,
      'WPT_URL'      => req.url.to_s,
      'WPT_HEADERS'  => JSON.generate(headers),
      'WPT_DOC_ROOT' => ROOT,
      'PYTHONDONTWRITEBYTECODE' => '1'   # no __pycache__ in the vendored WPT tree
    }
    out, status = Open3.capture2(py_env, 'python3', PY_HANDLER, pyfile, stdin_data: body, binmode: true)
    return nil unless status.success?
    nl = out.index("\n".b)
    return nil unless nl
    meta  = JSON.parse(out.byteslice(0, nl))
    rbody = out.byteslice(nl + 1, meta['body_len'].to_i) || ''.b
    hdrs  = {}
    Array(meta['headers']).each {|k, v| hdrs[k.to_s.downcase] = v.to_s }
    hdrs['content-type'] ||= 'text/plain'
    [meta['status'].to_i, hdrs, [rbody]]
  rescue StandardError, JSON::ParserError
    nil
  end

  # Emulate wptserve's server-side `{{…}}` substitution for `.sub.` files (the
  # subset our vendored corpus references). `req_path` feeds the `location[...]`
  # tokens. Unknown tokens are left verbatim so a new, unhandled pattern shows
  # up loudly as a literal `{{…}}` in a failing assertion rather than silently
  # mis-substituting to something plausible.
  def substitute(body, req_path, query = {})
    # File.binread gives ASCII-8BIT; splicing the UTF-8 replacement strings below
    # would raise Encoding::CompatibilityError the moment the body carries any
    # non-ASCII byte. `.sub.` templates are UTF-8 source, so reinterpret as such.
    body.dup.force_encoding('UTF-8').gsub(/\{\{([^}]+)\}\}/) do |whole|
      case Regexp.last_match(1)
      when 'host'                      then SUB_HOST
      when /\Aports\[http\]\[\d+\]\z/  then SUB_HTTP_PORT
      when /\Aports\[https\]\[\d+\]\z/ then SUB_HTTPS_PORT
      when 'location[scheme]'          then 'http'
      when 'location[host]'            then "#{SUB_HOST}:#{SUB_HTTP_PORT}"
      when 'location[port]'            then SUB_HTTP_PORT
      when 'location[path]'            then req_path
      when /\Adomains\[(\w*)\]\z/      then (m = Regexp.last_match(1)).empty? ? SUB_HOST : "#{m}.#{SUB_HOST}"
      when /\Ahosts\[alt\]\[(\w*)\]\z/ then (m = Regexp.last_match(1)).empty? ? SUB_ALT_HOST : "#{m}.#{SUB_ALT_HOST}"
      when /\Ahosts\[\]\[(\w*)\]\z/    then (m = Regexp.last_match(1)).empty? ? SUB_HOST : "#{m}.#{SUB_HOST}"
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

  def app
    @app ||= Rack::Builder.new {
      run lambda {|env|
        req  = Rack::Request.new(env)
        path = req.path_info
        # `encoding.py?label=X` — WPT's charset CGI. We don't run Python; emulate
        # its one behaviour (echo the label into a `<meta charset>`), which is
        # all the characterSet-normalization tests need. No byte decoding (the
        # body is ASCII).
        if path.end_with?('/encoding.py')
          label = req.params['label'].to_s.gsub('&', '&amp;').gsub('"', '&quot;').gsub('<', '&lt;')
          next [200, {'content-type' => 'text/html'}, [%{<!doctype html><meta charset="#{label}">}]]
        end
        # `redirect.py` — WPT's redirect CGI: respond `status` (default 302) with
        # a `Location` header from the `location` param. rack_fetch follows it, so
        # a frame's document.URL becomes the final target (WPT dom/nodes/Document-URL).
        if path.end_with?('/redirect.py')
          loc = req.params['location'].to_s
          # A real redirect needs a target; a blank Location would self-loop
          # (rack_fetch follows an empty-but-truthy Location back to here).
          next [400, {'content-type' => 'text/plain'}, ['missing location']] if loc.empty?
          status = req.params['status'].to_s =~ /\A3\d\d\z/ ? req.params['status'].to_i : 302
          next [status, {'content-type' => 'text/plain', 'location' => loc}, []]
        end
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
        # wptserve answers a directory request (e.g. GET `/`) with a 200 listing;
        # Document.currentScript's xhr-test does a sync GET `/` and gates on
        # status === 200. Mirror that for in-tree directories.
        if (file == WptRunner::ROOT || file.start_with?(WptRunner::ROOT + '/')) && File.directory?(file)
          next [200, {'content-type' => 'text/html'}, ['']]
        end
        unless file.start_with?(WptRunner::ROOT + '/') && File.file?(file)
          next [404, {'content-type' => 'text/plain'}, ['not found']]
        end

        ct   = WptRunner::CONTENT_TYPES.fetch(File.extname(path).downcase, 'text/plain')
        body = File.binread(file)
        body = WptRunner.substitute(body, path, req.GET) if File.basename(path).include?('.sub.')
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
        [200, resp_headers, [body]]
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
  end

  # Every real testharness test file under dom/ — i.e. one that pulls in
  # testharness.js. Reference / manual / support / resources files are not
  # tests and are skipped. Files on the skip list (driver crashers — see
  # `skip`) are excluded here so they neither run nor need an allowlist entry.
  # Top-level trees + the narrow html/ subtrees we vendor: the event-loop oracle
  # (timers + microtask-queuing) and the forms semantics surface (form
  # submission / constraint validation / input / select / textarea / labels —
  # the form-driven slice every app suite exercises). See script/vendor_wpt.mjs.
  TREES = '{dom,domparsing,url,encoding,shadow-dom,FileAPI,html/dom,html/webappapis/timers,html/webappapis/microtask-queuing,html/semantics/forms}'

  # `.any.js` / `.window.js` trees safe to scan: url/ + encoding/ + the html/
  # event-loop oracle (all time-probed crasher-free). The dom/ + forms `.any.js`
  # sets are still excluded — dom/ has synchronous-infinite-loop crashers that
  # hang the V8 call (no virtual-clock timeout catches them); forms `.any.js`
  # (~17 files) is deferred until the `.html` set is triaged. Both need skip-list
  # triage before they can be scanned.
  JS_TREES = '{url,encoding,FileAPI,html/webappapis/timers,html/webappapis/microtask-queuing}'

  def test_files
    @test_files ||= begin
      html = Dir.glob("#{TREES}/**/*.{html,xhtml,xht}", base: ROOT).reject {|rel|
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
    sub = File.basename(rel).include?('.sub.')
    @session = nil if sub
    s = session
    # One session runs the whole suite, so its history accumulates every prior
    # file's visit. Clear it before each file — otherwise a test that calls
    # `history.back()` (select-restore-invalid-option's bfcache round-trip, the
    # selectedcontent-restore files, …) traverses the SHARED history back into
    # the PREVIOUS file's document, re-runs its testharness, and reports THAT
    # file's results here — making the gate depend on visit order. Per-file
    # reset matches real WPT's fresh-browsing-context-per-file isolation.
    s.driver.reset_history!
    # `.any.js` / `.window.js` tests run through their synthesized HTML wrapper;
    # a variant query (if any) is appended to the visited URL.
    visit = rel.end_with?('.any.js', '.window.js') ? rel.sub(/\.js\z/, '.html') : rel
    visit = "#{visit}#{query}"
    s.visit(sub ? "#{SUB_ORIGIN}/#{visit}" : "/#{visit}")
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
    @session = nil
    {completed: false, error: e.message}
  ensure
    # Drop the cross-origin session so the next (non-sub) file starts fresh on
    # the default origin — see the `sub` isolation note above.
    @session = nil if sub
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
