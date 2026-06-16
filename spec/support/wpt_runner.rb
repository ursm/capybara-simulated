# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'yaml'
require 'set'

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
  ROOT          = File.expand_path('../wpt', __dir__)
  EXPECTED_PATH = File.expand_path('wpt_expected_failures.yml', __dir__)
  SKIP_PATH     = File.expand_path('wpt_skip.yml', __dir__)

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
  DRAIN_STEP_MS      = 250
  DRAIN_STEPS        = 8   # 8 × 250 ms = 2 s virtual before forcing the timeout
  FORCE_TIMEOUT_MS   = 12_000  # > the 10 s normal harness timeout (+ margin)
  LONG_TIMEOUT_MS    = 55_000  # cumulative ≈ 67 s > the 60 s `meta timeout=long`
  POST_TIMEOUT_STEPS = 3   # let a completion that chains through a final
                           # microtask / timer hop land after the jump
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
    '.css'  => 'text/css'
  }.freeze

  module_function

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
        # `.any.js` / `.window.js` multi-global tests ship only the JS source; WPT
        # generates the per-global HTML wrapper at serve time. Synthesize the
        # window-variant wrapper (`X.any.html` ← `X.any.js`) on request: testharness
        # + report + each `// META: script=` dep + the test source.
        if (m = path.match(%r{\A(/.+\.(?:any|window))\.html\z})) && File.file?(File.expand_path(File.join(WptRunner::ROOT, "#{m[1]}.js")))
          next [200, {'content-type' => 'text/html'}, [WptRunner.any_js_wrapper("#{m[1].sub(%r{\A/}, '')}.js")]]
        end
        file = File.expand_path(File.join(WptRunner::ROOT, path))
        unless file.start_with?(WptRunner::ROOT + '/') && File.file?(file)
          next [404, {'content-type' => 'text/plain'}, ['not found']]
        end

        ct = WptRunner::CONTENT_TYPES.fetch(File.extname(path).downcase, 'text/plain')
        [200, {'content-type' => ct}, [File.binread(file)]]
      }
    }.to_app
  end

  def session
    @session ||= Capybara::Session.new(:simulated, app)
  end

  # Every real testharness test file under dom/ — i.e. one that pulls in
  # testharness.js. Reference / manual / support / resources files are not
  # tests and are skipped. Files on the skip list (driver crashers — see
  # `skip`) are excluded here so they neither run nor need an allowlist entry.
  # Top-level trees + the narrow html/ event-loop oracle subtrees (timers +
  # microtask-queuing — the only layout-free slices of html/ we vendor; see
  # script/vendor_wpt.mjs).
  TREES = '{dom,domparsing,url,encoding,shadow-dom,html/webappapis/timers,html/webappapis/microtask-queuing}'

  # `.any.js` / `.window.js` trees safe to scan: url/ + encoding/ + the html/
  # event-loop oracle (all time-probed crasher-free). The dom/ `.any.js` set is
  # still excluded — it has synchronous-infinite-loop crashers that hang the V8
  # call (no virtual-clock timeout catches them) and needs skip-list triage first.
  JS_TREES = '{url,encoding,html/webappapis/timers,html/webappapis/microtask-queuing}'

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

  # Run one test file. Returns a Hash:
  #   { completed: true,  failing: ["subtest name", …] }   # harness finished
  #   { completed: false, error: "…" | nil }               # never completed
  def run(rel)
    s = session
    # `.any.js` / `.window.js` tests run through their synthesized HTML wrapper.
    visit = rel.end_with?('.any.js', '.window.js') ? rel.sub(/\.js\z/, '.html') : rel
    s.visit "/#{visit}"
    # The driver doesn't auto-fire window 'load'; testharness completes its
    # sync tests off that event (then a setTimeout(0) sets `all_loaded`).
    s.evaluate_script("window.dispatchEvent(new Event('load'))")

    res = nil
    DRAIN_STEPS.times do
      s.evaluate_script("typeof __drainTimers === 'function' ? __drainTimers(#{DRAIN_STEP_MS}, #{DRAIN_ITER}) : null")
      res = s.evaluate_script('globalThis.__wptResults')
      break unless res.nil?
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
        s.evaluate_script("typeof __drainTimers === 'function' ? __drainTimers(#{DRAIN_STEP_MS}, #{DRAIN_ITER}) : null")
        res = s.evaluate_script('globalThis.__wptResults')
      end
    end

    return {completed: false, error: nil} if res.nil?

    failing = res['tests'].reject {|t| t['status'].to_i.zero? }.map {|t| t['name'] }
    {completed: true, failing: failing}
  rescue StandardError => e
    # A file that errored may have left the shared session in a bad state;
    # rebuild it so the next file (and the result) doesn't depend on run order.
    @session = nil
    {completed: false, error: e.message}
  end

  def expected
    @expected ||= File.exist?(EXPECTED_PATH) ? (YAML.safe_load_file(EXPECTED_PATH) || {}) : {}
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
