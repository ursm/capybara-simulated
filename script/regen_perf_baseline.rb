# frozen_string_literal: true

# Regenerate the perf gate's baseline (spec/support/perf_baseline.yml) by
# running the workload through the :simulated driver and recording its op-counts
# and wall ratio. Run after an intended perf change — a win to lock in, or a
# conformance fix that legitimately shifts the counts — then review the diff:
#
#   bundle exec ruby script/regen_perf_baseline.rb
#
# The op-counts are deterministic (machine-independent); the wall ratio is
# captured on this machine and only drives the SOFT warning, so its exact value
# is advisory. Counts are re-measured a few times and required to agree, so a
# flaky counter can never be baked into a "hard" baseline.
$LOAD_PATH.unshift(File.expand_path('../lib', __dir__))

require 'capybara/simulated'
require_relative '../spec/support/perf_gate'

CONFIRM_RUNS = 3

counts = Array.new(CONFIRM_RUNS) { PerfGate.capture_counts }
unless counts.uniq.size == 1
  warn 'Refusing to write baseline: op-counts are NOT reproducible across runs.'
  counts.each_with_index {|c, i| warn "  run #{i + 1}: #{c.inspect}" }
  warn 'A counter in COUNTS_JS jitters — drop it or make the workload deterministic before baselining.'
  exit 1
end

data = { PerfGate::WORKLOAD => { 'counts' => counts.first, 'wall' => PerfGate.capture_wall } }
File.write(PerfGate::BASELINE_PATH, data.to_yaml)

puts "wrote #{PerfGate::BASELINE_PATH}"
puts data.to_yaml
