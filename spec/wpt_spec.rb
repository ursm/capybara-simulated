# frozen_string_literal: true

require_relative 'support/wpt_runner'

# Behavioural-conformance gate: runs a pinned subset of web-platform-tests
# (vendored under spec/wpt/, currently the dom/ suite) through the :simulated
# driver and holds each file to its recorded result.
#
# This is the behavioural counterpart to idl_coverage_spec: that gate asserts
# an API *exists*; this one asserts it *behaves* per the WHATWG DOM spec, using
# the same tests Chromium and Firefox hold themselves to. Each file's expected
# non-PASS subtests are split across two allowlists:
#
#   - spec/support/wpt_expected_failures.yml — IN-SCOPE backlog (real driver gaps
#     we intend to fix; shrinking this is the roadmap)
#   - spec/support/wpt_out_of_scope.yml      — EARNED non-goals (need a subsystem
#     we deliberately don't model, per CLAUDE.md rule 1), each with a reason
#
# The gate is symmetric over the UNION of both, exactly like the IDL allowlist:
#
#   - a subtest that newly FAILs and isn't listed  -> RED (regression / new gap)
#   - a listed subtest that now PASSes             -> RED (stale; delete the line)
#   - a file that flips completed <-> HARNESS_ERROR -> RED
#
# So fixing a driver gap forces its lines out of the allowlist, and a regression
# that breaks a passing subtest turns the suite red immediately. Shrinking the
# in-scope allowlist (and the wpt_skip.yml crasher list) is the parity roadmap.
#
# Regenerate the allowlist after a driver fix:
#   bundle exec ruby script/regen_wpt_expected_failures.rb
#
# Tagged :wpt so it can be skipped locally with `rspec --tag ~wpt`; CI runs it.
RSpec.describe 'WPT conformance (dom/)', :wpt do
  HARNESS_ERROR = WptRunner::HARNESS_ERROR

  it 'has a vendored harness and test corpus' do
    expect(File).to exist(File.join(WptRunner::ROOT, 'resources', 'testharness.js'))
    expect(WptRunner.test_files).not_to be_empty
  end

  # Self-healing for WICG / pre-standard out-of-scope entries: unlike `.tentative`
  # tests (whose path changes on ratification, auto-returning them to the gate), a
  # WICG-tagged entry with an ordinary filename gives no signal when it standardizes.
  # Detect that via the test's own `<link rel=help>` — when it no longer references
  # WICG, re-audit (it's likely now in-scope). Runs at every gate (and WPT bump).
  it 'WICG-excused out-of-scope entries still reference WICG (else re-audit — likely standardized)' do
    drift = WptRunner.wicg_drift
    expect(drift).to be_empty,
      "Out-of-scope entries tagged #{WptRunner::WICG_REASON_TAG} (WICG/pre-standard) whose " \
      "<link rel=help> no longer references WICG — the proposal likely standardized; re-audit " \
      "and move to wpt_expected_failures.yml (in-scope) or fix:\n" +
      drift.map {|rel, helps| "  - #{rel}  (help: #{helps.join(', ')})" }.join("\n")
  end

  WptRunner.skip.each do |rel, reason|
    it("#{rel} (driver crasher — skipped)") { skip reason.to_s.strip }
  end

  # Compare one file's run against its allowlist; returns the mismatch message(s), or [] on a match.
  # Pure (no `expect`) so the retry loop below can re-run a file and only assert on the final result.
  def wpt_file_mismatches(rel)
    result   = WptRunner.run(rel)
    expected = WptRunner.expected[rel]
    errs     = []

    if result[:completed]
      if expected == HARNESS_ERROR
        return ["#{rel}: harness now completes but is allowlisted as HARNESS_ERROR — " \
                'regenerate with script/regen_wpt_expected_failures.rb']
      end
      # Multiset diff (not Array#-) so duplicate subtest names are held to their recorded
      # multiplicity — see WptRunner.multiset_minus.
      new_failures = WptRunner.multiset_minus(result[:failing], Array(expected)).sort
      now_passing  = WptRunner.multiset_minus(Array(expected), result[:failing]).sort

      unless new_failures.empty?
        errs << "#{rel}: subtests newly NOT passing (fix the driver, or list them — " \
                "in spec/support/wpt_expected_failures.yml if in-scope, or " \
                "spec/support/wpt_out_of_scope.yml with a reason if an earned " \
                "non-goal):\n  - #{new_failures.join("\n  - ")}"
      end
      unless now_passing.empty?
        errs << "#{rel}: allowlisted subtests now PASS — remove from " \
                "spec/support/wpt_expected_failures.yml or wpt_out_of_scope.yml " \
                "(whichever lists them):\n  - #{now_passing.join("\n  - ")}"
      end
    elsif expected != HARNESS_ERROR
      errs << "#{rel}: harness did not complete, but it is not allowlisted as " \
              'HARNESS_ERROR (a previously-completing file regressed, or it is a ' \
              'new file) — investigate or regenerate the allowlist'
    end
    errs
  end

  # A handful of service-worker files carry an order-dependent timing flake under the full-suite
  # load: a client↔SW message / respondWith reply is a cross-isolate transfer that must complete on
  # the worker thread, and a slower / more-loaded runner (CI) can starve that thread enough to miss
  # it — the file passes cleanly in isolation but intermittently reds a full run. Re-running a
  # MISMATCHING file a few times lets a transient miss pass on a clean retry, while a genuine
  # regression (mismatches every attempt) still reds the gate. See the SW-message-reply race in the
  # SW campaign notes; the real fix is deterministic SW-reply delivery under the virtual clock.
  WPT_FILE_ATTEMPTS = 3

  WptRunner.test_files.each do |rel|
    it rel do
      mismatches = []
      WPT_FILE_ATTEMPTS.times do
        mismatches = wpt_file_mismatches(rel)
        break if mismatches.empty?
      end
      expect(mismatches).to be_empty, mismatches.join("\n\n")
    end
  end
end
