# frozen_string_literal: true

require_relative '../support/perf_gate'

# Performance regression gate: one fixed workload held to a recorded baseline —
# deterministic op-counts (hard) + a normalized wall ratio (soft warn). See
# spec/support/perf_gate.rb for the rationale and the regen command. Tagged
# :perf so the QuickJS CI job skips it (the baseline is captured on V8).
RSpec.describe 'perf gate', :perf do
  PerfGate.install(self)
end
