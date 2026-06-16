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

  WptRunner.skip.each do |rel, reason|
    it("#{rel} (driver crasher — skipped)") { skip reason.to_s.strip }
  end

  WptRunner.test_files.each do |rel|
    it rel do
      result   = WptRunner.run(rel)
      expected = WptRunner.expected[rel]

      if result[:completed]
        expect(expected).not_to eq(HARNESS_ERROR),
          "#{rel}: harness now completes but is allowlisted as HARNESS_ERROR — " \
          'regenerate with script/regen_wpt_expected_failures.rb'

        expected_failing = Array(expected)
        actual_failing   = result[:failing]

        # Multiset diff (not Array#-) so duplicate subtest names are held to
        # their recorded multiplicity — see WptRunner.multiset_minus.
        new_failures = WptRunner.multiset_minus(actual_failing, expected_failing).sort
        now_passing  = WptRunner.multiset_minus(expected_failing, actual_failing).sort

        expect(new_failures).to be_empty,
          "#{rel}: subtests newly NOT passing (fix the driver, or list them — " \
          "in spec/support/wpt_expected_failures.yml if in-scope, or " \
          "spec/support/wpt_out_of_scope.yml with a reason if an earned " \
          "non-goal):\n  - #{new_failures.join("\n  - ")}"

        expect(now_passing).to be_empty,
          "#{rel}: allowlisted subtests now PASS — remove from " \
          "spec/support/wpt_expected_failures.yml or wpt_out_of_scope.yml " \
          "(whichever lists them):\n  - #{now_passing.join("\n  - ")}"
      else
        expect(expected).to eq(HARNESS_ERROR),
          "#{rel}: harness did not complete, but it is not allowlisted as " \
          'HARNESS_ERROR (a previously-completing file regressed, or it is a ' \
          'new file) — investigate or regenerate the allowlist'
      end
    end
  end
end
