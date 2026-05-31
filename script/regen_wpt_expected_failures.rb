# Dev helper: regenerate spec/support/wpt_expected_failures.yml by running the
# whole vendored WPT subset and recording each file's current non-PASS state.
# Run after implementing a fix so the symmetric conformance gate stays honest.
#
#   bundle exec ruby script/regen_wpt_expected_failures.rb
#
# Output per file (only files with something to record are listed):
#   "dom/nodes/Node-appendChild.html":
#   - "Appending to a text node"        # subtest currently FAIL/TIMEOUT/NOTRUN
#   "dom/nodes/some-broken.html": HARNESS_ERROR   # harness never completed
#
# Serialized with Psych (not String#inspect) so the writer's escape grammar is
# the exact inverse of the gate's YAML.safe_load_file reader — a subtest name
# containing e.g. `#{` would make an inspect-quoted scalar that Psych rejects.
#
# The wpt_spec gate is symmetric: a non-PASS subtest not listed here turns the
# suite RED (fix it or list it), and a listed subtest that now PASSes ALSO turns
# it RED (delete the stale line). Shrinking this file is the parity roadmap.
require_relative '../spec/support/wpt_runner'

files = WptRunner.test_files
warn "Running #{files.size} WPT files…"

expected = {}
completed_count = 0
error_count = 0
fail_subtests = 0

files.each_with_index do |rel, i|
  result = WptRunner.run(rel)
  if result[:completed]
    completed_count += 1
    # Keep the full multiset (no uniq): a subtest name that fails more than once
    # must be recorded with its multiplicity, or the gate's multiset comparison
    # under-counts it and a later same-named regression slips through green.
    failing = result[:failing].sort
    unless failing.empty?
      expected[rel] = failing
      fail_subtests += failing.size
    end
  else
    error_count += 1
    expected[rel] = WptRunner::HARNESS_ERROR
  end
  warn "\r  #{i + 1}/#{files.size}" if ((i + 1) % 25).zero? || i + 1 == files.size
end
warn ''

hdr = <<~H
  # WPT expected non-PASS state — the behavioural-conformance backlog for the
  # vendored web-platform-tests subset (spec/wpt/), made measurable.
  #
  # Each entry is one test file:
  #   - a list of subtest names currently NOT passing (FAIL / TIMEOUT / NOTRUN), or
  #   - the string HARNESS_ERROR if the harness never reached completion
  #     (unsupported include, parse crash, or a real hang hitting the harness
  #     timeout) so no per-subtest results are available.
  #
  # spec/wpt_spec.rb is symmetric, mirroring the IDL gate:
  #   - a non-PASS subtest NOT listed here          -> RED (regression / new gap)
  #   - a listed subtest that now PASSes             -> RED (stale; delete it)
  #   - a file that now completes but is HARNESS_ERROR (or vice-versa) -> RED
  # So fixing a driver gap forces its lines out, and a regression that drops a
  # passing subtest is caught immediately. Shrinking this file is the roadmap.
  #
  # Regenerate after a driver fix with:
  #   bundle exec ruby script/regen_wpt_expected_failures.rb
  #
H

# Build a key-sorted hash and let Psych emit it: real YAML escaping so every
# subtest name round-trips through YAML.safe_load_file byte-for-byte.
ordered = expected.keys.sort.each_with_object({}) {|rel, h| h[rel] = expected[rel] }

File.write(WptRunner::EXPECTED_PATH, hdr + ordered.to_yaml)

warn "wrote #{WptRunner::EXPECTED_PATH}"
warn "  files:          #{files.size}"
warn "  completed:      #{completed_count}"
warn "  harness errors: #{error_count}"
warn "  listed files:   #{expected.size}"
warn "  fail subtests:  #{fail_subtests}"
