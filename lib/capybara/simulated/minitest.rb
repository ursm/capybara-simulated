# frozen_string_literal: true

require 'minitest'
require_relative 'trace_persistence'

# Minitest integration for trace file output. Require it from your
# `test_helper` / `application_system_test_case.rb`:
#
#   require 'capybara/simulated/minitest'
#
# With `CSIM_TRACE_DIR=/path/to/dir` set, each test that recorded a trace
# is persisted to `<dir>/<Class_test_name>.json` after it runs. Inert
# when the env var is unset. Whether a trace is recorded at all is
# governed separately by `CSIM_TRACE` (off / on-failure / full) — see
# Browser. Render a saved trace into an HTML viewer with
# `capybara-simulated trace <file>.json`.
module Capybara
  module Simulated
    module MinitestTrace
      module_function

      # Where the test method is defined, as `path:line` (best effort).
      def source_file(test)
        loc = test.class.instance_method(test.name).source_location
        loc && loc.join(':')
      rescue NameError
        nil
      end

      # Skips aren't failures for outcome purposes. `::Minitest` —
      # unqualified `Minitest` here resolves to `Capybara::Minitest`
      # (Capybara ships that submodule), which has no `Skip`.
      def real_failures(test)
        test.failures.reject {|f| f.is_a?(::Minitest::Skip) }
      end
    end
  end
end

if (dir = ENV['CSIM_TRACE_DIR']) && !dir.empty?
  FileUtils.mkdir_p(dir)
  # Prepend so `after_teardown` chains via `super` and we run after the
  # host's own teardown. Guarded by `tracing?` inside persist_all, so it
  # no-ops for every non-Capybara test.
  hook = Module.new do
    define_method(:after_teardown) do
      super()
    ensure
      begin
        fails = Capybara::Simulated::MinitestTrace.real_failures(self)
        Capybara::Simulated::TracePersistence.persist_all(
          dir,
          title:     "#{self.class}##{name}",
          file:      Capybara::Simulated::MinitestTrace.source_file(self),
          outcome:   fails.empty? ? 'passed' : 'failed',
          exception: fails.first&.message
        )
      rescue StandardError => e
        # Trace output must never turn a test red.
        warn "capybara-simulated: trace persist failed: #{e.message}"
      end
    end
  end
  Minitest::Test.prepend(hook)
end
