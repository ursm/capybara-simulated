# frozen_string_literal: true

# RSpec example-status persistence: rspec rewrites this file after every run
# with per-example statuses + run times. Two consumers:
#
#   - `flatware rspec spec` balances its per-worker buckets from the recorded
#     times (untimed files fall back to round-robin — measured 1:47 cold vs
#     1:03 warm on the full suite), and it self-refreshes, so there is nothing
#     to commit or regenerate. CI persists it across runs per job via
#     actions/cache (see .github/workflows/ci.yml), which also gives each
#     engine its own timing (QuickJS files run ~2x their V8 times).
#   - `rspec --only-failures` works locally for free.
#
# Per-engine path: one file per engine so the balances don't fight.
#
# Under flatware every worker process merge-writes this same file at exit;
# rspec's persister read-merges under an exclusive flock, so concurrent
# workers don't lose each other's entries.
#
# FORK DISCIPLINE (why this file is safe to load pre-fork): flatware forks its
# workers after loading `.rspec` requires but before loading any spec file.
# Nothing loaded pre-fork may boot a JS engine (a forked V8 crashes loudly) —
# keep `.rspec` requires config-only like this one, and keep engine boot lazy
# (isolates are created by sessions inside examples, never at require time).
RSpec.configure do |config|
  config.example_status_persistence_file_path = "tmp/rspec_examples_#{ENV.fetch('CSIM_JS_ENGINE', 'v8')}.txt"
end
