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
        # `engine` only when the driver can say — and never at the cost of the write: this method
        # exists to produce the trace file, so a driver call that raises must not take it down
        # (the same reason the screenshot below is in its own rescue). A driver that has no answer
        # leaves the key out rather than writing `null`.
        engine = begin
          driver.js_engine if driver.respond_to?(:js_engine)
        rescue StandardError
          nil
        end
        driver.current_trace.metadata.merge!(
          {title: title, file: file, outcome: outcome, exception: exception, engine: engine}.compact
        )
        # The state the example ENDED in, painted once — and painted HERE, after the example,
        # rather than per step: a paint is ~50 ms on V8 and ~525 ms on QuickJS, and doing it inside
        # an action's failure path puts it inside Capybara's retry window, where it can turn an
        # action a retry would have rescued into a failure (measured: a click waiting on an overlay
        # went from 35 ms to 563 ms). Only for a failure — that is the state anyone opens the trace
        # to look at, and a passing example should pay nothing.
        # …unless the host already took it, before its own teardown reset the page (see
        # `minitest.rb`). Whoever gets there first with a LIVE page wins.
        if outcome.to_s == 'failed' && !driver.current_trace.metadata[:screenshot] &&
           driver.respond_to?(:trace_screenshot)
          # In its own rescue, and rescuing more than `StandardError`: the paint is the one part of
          # persisting that runs arbitrary engine code, and the trace file — the thing this method
          # exists to write — must not be lost to it.
          begin
            shot = driver.trace_screenshot
            driver.current_trace.metadata[:screenshot] = shot if shot
          rescue Exception => e # rubocop:disable Lint/RescueException
            warn "capybara-simulated: trace screenshot failed: #{e.class}: #{e.message}"
          end
        end
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
