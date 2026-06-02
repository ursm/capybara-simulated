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
  # almost nothing. Only files with a still-pending test pay the full budget,
  # after which we call testharness's global `timeout()` to force every pending
  # subtest to TIMEOUT and complete the file. This keeps a hung async test from
  # draining its whole 10 s harness-timeout horizon (the difference between the
  # suite running in seconds vs. minutes).
  DRAIN_STEP_MS      = 250
  DRAIN_STEPS        = 8   # 8 × 250 ms = 2 s virtual before forcing timeout
  POST_TIMEOUT_STEPS = 3   # extra drains after timeout() so a multi-hop
                           # completion lands without paying 8× on every
                           # genuinely-stuck (HARNESS_ERROR) file
  DRAIN_ITER         = 5_000

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
  def test_files
    @test_files ||= Dir.glob('dom/**/*.{html,xhtml,xht}', base: ROOT).reject {|rel|
      rel.end_with?('-ref.html', '-manual.html', '-notref.html', '-ref.xhtml', '-manual.xhtml') ||
        (rel.split('/') & %w[support resources reftest]).any? ||
        skip.key?(rel)
    }.select {|rel|
      File.read(File.join(ROOT, rel)).include?('/resources/testharness.js')
    }.sort
  end

  # Files excluded from the run entirely because they crash or pathologically
  # hang the driver (deep-recursion stack overflow, runaway dispatch, …) rather
  # than merely producing wrong subtest results. This is the driver-crasher
  # backlog, kept separate from the per-subtest allowlist (wrong-behaviour
  # backlog). Maps relpath => reason. Shrinking it means fixing a driver crash.
  def skip
    @skip ||= File.exist?(SKIP_PATH) ? (YAML.safe_load_file(SKIP_PATH) || {}) : {}
  end

  # Run one test file. Returns a Hash:
  #   { completed: true,  failing: ["subtest name", …] }   # harness finished
  #   { completed: false, error: "…" | nil }               # never completed
  def run(rel)
    s = session
    s.visit "/#{rel}"
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
      # Still-pending test(s): force every pending subtest to TIMEOUT so the
      # harness completes and we get per-subtest results instead of nothing.
      # Drain a few more steps (not one) so a completion that chains through
      # several queued timer/microtask hops still lands here — otherwise a file
      # could sit on the completed-vs-HARNESS_ERROR fence and flap.
      s.evaluate_script("try { if (typeof timeout === 'function') timeout(); } catch (e) {}")
      POST_TIMEOUT_STEPS.times do
        s.evaluate_script("typeof __drainTimers === 'function' ? __drainTimers(#{DRAIN_STEP_MS}, #{DRAIN_ITER}) : null")
        res = s.evaluate_script('globalThis.__wptResults')
        break unless res.nil?
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
