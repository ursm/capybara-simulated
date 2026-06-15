# frozen_string_literal: true

require 'rspec/core'
require_relative 'trace_persistence'

# RSpec integration for trace file output. Require it from your
# `spec_helper` / `rails_helper`:
#
#   require 'capybara/simulated/rspec'
#
# With `CSIM_TRACE_DIR=/path/to/dir` set, each example that recorded a
# trace is persisted to `<dir>/<example slug>.json` after it runs. Inert
# when the env var is unset. Whether a trace is recorded at all is
# governed separately by `CSIM_TRACE` (off / on-failure / full) — see
# Browser. Render a saved trace into an HTML viewer with
# `capybara-simulated trace <file>.json`.
if (dir = ENV['CSIM_TRACE_DIR']) && !dir.empty?
  FileUtils.mkdir_p(dir)
  RSpec.configure do |config|
    # `prepend_after` so we capture the trace before a host's own
    # teardown (e.g. Capybara session reset) runs.
    config.prepend_after(:each) do |example|
      Capybara::Simulated::TracePersistence.persist_all(
        dir,
        title:     example.full_description,
        file:      example.location,
        outcome:   example.exception ? 'failed' : 'passed',
        exception: example.exception&.message
      )
    end
  end
end
