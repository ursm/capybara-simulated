# frozen_string_literal: true

require 'yaml'
require 'capybara'
require 'capybara/simulated'

# Performance regression gate — the SPEED counterpart to wpt_gate (which holds
# spec conformance). Speed is the driver's reason to exist (CLAUDE.md rule 3):
# it is in-process precisely to beat a real browser per test, and every WPT
# increment risks eroding that lead. This gate runs one fixed, representative
# workload through the :simulated driver and holds it to a recorded baseline on
# two axes.
#
#   1. DETERMINISTIC OP-COUNTS (hard gate) — layout passes, subtree-reuse hits
#      and refusals, structural-context sweeps, cascade versions, parser
#      generations. These are pure functions of the driver's LOGIC (no wall
#      clock), so they are identical across machines, Ruby versions and JS
#      engines; a run-to-run change means a real algorithmic change — an added
#      pass, a dropped reuse, an O(n²) creep. Held EXACTLY (WPT-gate style): any
#      deviation, UP or DOWN, reds the gate, so an improvement must be locked in
#      by regenerating the baseline. That ratchet walks the counts monotonically
#      down and stops a later change from silently giving a win back.
#
#   2. WALL RATIO (soft warn) — the workload's wall time divided by a fixed
#      pure-V8 arithmetic loop measured on the SAME machine in the SAME run. The
#      loop only ROUGHLY normalizes machine speed (the bench/dom_scaling
#      technique: ratios, not absolute times): it does no host calls, allocation
#      or GC, while the workload crosses the Ruby-V8 boundary, allocates DOM and
#      triggers GC, so contention / JIT tier-up touch the two differently and the
#      ratio drifts somewhat on its own. Good enough for a 25%-tolerance trend
#      signal, not an invariant. The warning also goes to $GITHUB_STEP_SUMMARY (a
#      durable, visible CI surface), since a reporter message from a flatware
#      worker on a passing run is easily lost.
#      A constant-factor slowdown the counts CAN'T see — more work per element,
#      not more elements — raises it. Wall is noisy under a loaded CI runner, so
#      this only WARNS; it never reds the gate. But it surfaces the
#      constant-factor creep that is the driver's real existential risk, which a
#      count-only gate would hide behind a green check.
#
# Regenerate the baseline after an intended change (a perf win to lock in, or a
# conformance fix that legitimately shifts the counts):
#   bundle exec ruby script/regen_perf_baseline.rb
#
# Tagged :perf and run in its OWN serial CI step, never the flatware pool: the
# workload is a multi-second CPU burst that would starve timing-sensitive async
# tests in sibling workers (it flaked the ActionCable subscription test) and that
# contention would wreck its own wall ratio. The V8 job runs it once (isolated);
# both flatware runs exclude it via `--tag '~perf'`. The baseline is captured on
# V8, exactly as the WPT allowlist is. See ci.yml.
module PerfGate
  BASELINE_PATH = File.expand_path('perf_baseline.yml', __dir__)

  # The single workload's key in the baseline. A Hash-of-workloads so a second
  # shape (a form-heavy page, a deep SPA swap) can be added without reshaping.
  WORKLOAD = 'grid_table'

  # Wall ratio may sit this fraction above baseline before the soft warning
  # fires. Generous on purpose: wall is a trend signal, not a tripwire.
  WALL_WARN_TOL = 0.25

  # Warm-up then measured reps for the wall medians — the steady (JIT-warm)
  # cost, matching bench/dom_scaling's methodology. Kept small: the gate runs in
  # its own serial CI step (never the flatware pool — see ci.yml), so this is a
  # few seconds, and the wall axis is only a soft trend signal anyway.
  WALL_WARMUP = 1
  WALL_REPS   = 3

  # Rows in the workload table. Big enough that a real O(n²) slip shows in the
  # counts / ratio, small enough to keep the gate a second or two.
  ROWS = 400

  # A representative app-shaped page: a wide table (sibling / live-collection
  # width), rows nesting a few elements (ancestor walks), and a stylesheet whose
  # rules are DYNAMIC (`:hover`, a state class, an ancestor toggle) so the
  # cascade + layout run for real and the interaction below exercises reuse.
  #
  # INVARIANT — keep this workload's op-counts geometry-independent. Fonts are
  # resolved per machine (fc-match substitutes silently), so text width differs
  # on CI; the held counters must not depend on it. Today they don't (passes are
  # read-driven; reuse compares each run against its own prior pass; the counters
  # kept are font-independent). Don't introduce anything that lets geometry move
  # structure — wrapping text that changes box/line count, or a reuse refusal
  # keyed on a sub-pixel width — or the hard gate will red on CI only.
  def self.workload_html
    rows = (1..ROWS).map {|i|
      %(<tr class="row r#{i % 6}" id="row-#{i}">) +
        %(<td class="cell num">#{i}</td>) +
        %(<td class="cell"><a class="link" href="#x#{i}">item #{i}</a></td>) +
        %(<td class="cell"><span class="badge">#{i % 3}</span></td>) +
        '</tr>'
    }.join
    <<~HTML
      <!doctype html><html><head><style>
        table { border-collapse: collapse }
        .row { height: 24px }
        .row.r3 { background: #eee }
        .cell { padding: 2px 8px; border: 1px solid #ccc }
        .row:hover .cell { background: #def }
        .row.selected .cell { font-weight: bold; background: #ffe }
        .badge { display: inline-block; min-width: 16px }
        #container.compact .cell { padding: 0 4px }
      </style></head><body>
        <main id="container"><table id="grid"><tbody>#{rows}</tbody></table></main>
      </body></html>
    HTML
  end

  # The fixed interaction, run once in the loaded page. Each mutate-then-read
  # pair forces a layout pass; the reads after a localized change are where
  # subtree reuse is (or isn't) granted. All deterministic — no timers, no
  # waiting — so the op-counts it produces are reproducible.
  INTERACTION_JS = <<~JS.freeze
    (() => {
      const rows = document.querySelectorAll('#grid .row');
      let h = 0;
      const readAll = () => { for (const r of rows) h += r.getBoundingClientRect().height; };
      readAll();                                                  // initial geometry
      document.getElementById('container').classList.add('compact'); // ancestor toggle -> cascade + wide relayout
      readAll();
      let i = 0;
      for (const r of rows) { if ((i++ & 1) === 0) r.classList.add('selected'); } // state class on half
      readAll();                                                  // partial relayout; untouched rows reuse
      for (let k = 0; k < 20; k++) document.querySelectorAll('#grid .link').length; // structural queries
      return h;
    })()
  JS

  # A pure-V8 arithmetic loop — no DOM, no driver code. Its wall is the machine's
  # raw JS throughput this run, the denominator that normalizes the workload wall.
  CALIB_JS = 'let s = 0; for (let i = 0; i < 3000000; i++) { s += (i * 7) % 13; } s'

  # The counters the hard gate holds — deliberately only the LAYOUT/REUSE hot-path
  # signals. `__csimParserTreeGen` (essentially a node count) and
  # `__csimCascadeVersion` (bumps on any rule-set change / reset) were left out on
  # purpose: they shift on parse5 bumps, UA-sheet edits and conformance-driven
  # invalidation changes that are NOT perf regressions, so holding them exactly
  # would red the gate on unrelated PRs and train everyone to reflexively regen —
  # eroding the ratchet. These five move only when the driver does more (or less)
  # layout work. Read as one object so a single round-trip captures the vector.
  COUNTS_JS = <<~JS.freeze
    ({
      passes:            globalThis.__csimLayoutPasses(),
      reuse_hit:         globalThis.__csimReuseStats().hit,
      reuse_remeasured:  globalThis.__csimReuseStats().remeasured,
      reuse_escapingAbs: globalThis.__csimReuseStats().escapingAbs,
      ctx_sweeps:        globalThis.__csimCtxSweeps()
    })
  JS

  # Run the workload and return { 'counts' => {...int}, 'wall' => {...} }. Used
  # by both the gate (install) and the regen script, so they can never diverge.
  def self.capture
    { 'counts' => capture_counts, 'wall' => capture_wall }
  end

  # Counts come from a FRESH session (counters start at 0 on a new VM), so the
  # returned values are the workload's absolute op-counts, not a diff.
  def self.capture_counts
    with_session do |session|
      session.visit('/')
      session.evaluate_script(INTERACTION_JS)
      session.evaluate_script(COUNTS_JS).transform_keys(&:to_s).transform_values(&:to_i)
    end
  end

  def self.capture_wall
    with_session do |session|
      session.visit('/')   # warm the realm + JIT before timing
      workload = median_ms { session.visit('/'); session.evaluate_script(INTERACTION_JS) }
      calib    = median_ms { session.evaluate_script(CALIB_JS) }
      {
        'workload_ms' => workload.round(3),
        'calib_ms'    => calib.round(3),
        'ratio'       => (workload / calib).round(3)
      }
    end
  end

  def self.baseline
    YAML.safe_load_file(BASELINE_PATH)
  end

  # Wire the gate into an RSpec example group. Captures ONCE in before(:context)
  # (so a `--tag ~perf` run pays nothing), then asserts the two axes.
  def self.install(group)
    base = baseline.fetch(WORKLOAD)
    group.class_exec do
      before(:context) do
        @measured = PerfGate.capture
      end

      it 'layout / cascade op-counts match the baseline (hard)' do
        expected = base.fetch('counts')
        actual   = @measured.fetch('counts')
        mismatches = (expected.keys | actual.keys).sort.filter_map {|k|
          next if expected[k] == actual[k]
          "  - #{k}: baseline #{expected[k].inspect} → now #{actual[k].inspect}"
        }
        expect(mismatches).to be_empty,
          "perf op-counts changed for #{PerfGate::WORKLOAD}. This is a REGRESSION (added passes / " \
          "dropped subtree reuse / O(n²) creep) or an IMPROVEMENT to lock in. If the shift is " \
          "intended, regenerate the baseline:\n" \
          "  bundle exec ruby script/regen_perf_baseline.rb\n\n" +
          mismatches.join("\n")
      end

      it 'wall/calibration ratio within the soft budget (warn only, never reds)' do
        expected = base.fetch('wall').fetch('ratio')
        actual   = @measured.fetch('wall').fetch('ratio')
        ceiling  = expected * (1 + PerfGate::WALL_WARN_TOL)
        if actual > ceiling
          wall = @measured.fetch('wall')
          PerfGate.warn_soft(
            "[perf][WARN] #{PerfGate::WORKLOAD} wall ratio #{actual} > baseline #{expected} × " \
            "#{(1 + PerfGate::WALL_WARN_TOL).round(2)} = #{ceiling.round(3)} " \
            "(workload #{wall['workload_ms']}ms / calib #{wall['calib_ms']}ms). A constant-factor " \
            'slowdown the op-counts cannot see — NOT blocking. Investigate, or regen if intended.'
          )
        end
        # Soft: the wall axis warns but never fails. The example asserts only that
        # the measurement was taken, so the gate's pass/fail stays deterministic.
        expect(actual).to be > 0
      end
    end
  end

  # Emit a non-failing warning to durable surfaces. stderr always (inherited by
  # flatware workers); the GitHub Actions job summary when present (survives a
  # green multi-process log, where an RSpec reporter message from a worker does
  # not reliably reach the aggregating parent). Best-effort — a warning must
  # never itself break the run.
  def self.warn_soft(message)
    warn(message)
    summary = ENV['GITHUB_STEP_SUMMARY']
    File.write(summary, message + "\n", mode: 'a') if summary && !summary.empty?
  rescue StandardError
    # a lost warning is acceptable; a raised one is not
  end

  # --- internals ---------------------------------------------------------------

  def self.with_session
    # `:simulated` is registered on `require 'capybara/simulated'` (lib/capybara/simulated.rb).
    app     = workload_html.then {|html| ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }
    session = Capybara::Session.new(:simulated, app)
    begin
      yield session
    ensure
      # `dispose` (not `quit` — the driver has none) is the eager isolate-drop path
      # the driver header prescribes; without it each capture leaks its V8 isolate
      # (heap + workers) into the process-wide live set until at_exit. Idempotent.
      session.driver.dispose if session.driver.respond_to?(:dispose)
    end
  end

  def self.median_ms
    WALL_WARMUP.times { yield }
    reps = Array.new(WALL_REPS) {
      t = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      yield
      (Process.clock_gettime(Process::CLOCK_MONOTONIC) - t) * 1000.0
    }
    reps.sort[reps.size / 2]
  end
end
