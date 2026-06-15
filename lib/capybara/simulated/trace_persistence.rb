# frozen_string_literal: true

require 'fileutils'
require 'capybara/simulated'

module Capybara
  module Simulated
    # Framework-agnostic trace file-output, shared by the RSpec
    # (`capybara/simulated/rspec`) and Minitest
    # (`capybara/simulated/minitest`) integrations. Each of those reads
    # `CSIM_TRACE_DIR` and feeds the per-example outcome here; this just
    # stamps metadata and writes `<slug>.json`.
    module TracePersistence
      module_function

      # Filename-safe slug: keep word-ish chars, collapse the rest to one
      # `_`, cap length so a long description can't blow the path limit.
      def slug(name)
        name.to_s.gsub(/[^A-Za-z0-9._-]+/, '_')[0, 200]
      end

      # Stamp the outcome onto one driver's trace and write it. No-op
      # unless the driver actually recorded something.
      def persist(driver, dir, title:, file:, outcome:, exception:)
        return unless driver.respond_to?(:tracing?) && driver.tracing?
        driver.current_trace.metadata.merge!(
          title:     title,
          file:      file,
          outcome:   outcome,
          exception: exception
        )
        driver.stop_tracing(path: File.join(dir, "#{slug(title)}.json"))
      end

      # Persist every tracing simulated driver on the current thread
      # (one example normally has exactly one). Trace output must never
      # change a test's result, so a write failure is warned and
      # swallowed rather than propagated out of the after-hook.
      def persist_all(dir, **fields)
        Capybara::Simulated::Driver.each_live_on_thread(Thread.current) do |driver|
          persist(driver, dir, **fields)
        rescue StandardError => e
          warn "capybara-simulated: failed to write trace: #{e.message}"
        end
      end
    end
  end
end
