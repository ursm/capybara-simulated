# frozen_string_literal: true

require 'json'
require 'fileutils'

module Capybara
  module Simulated
    # Per-test trace of Capybara actions with DOM snapshots, console
    # output, and network requests interleaved. JSON output, one file
    # per test — downstream tooling builds whatever viewer it wants.
    #
    # Off by default. `CSIM_TRACE_DIR=/path/to/dir` enables auto-mode
    # via `Browser#record_action`; the RSpec hook in `csim_rspec.rb`
    # persists with a slugged filename. Programmatic activation is via
    # `Driver#start_tracing` / `#stop_tracing`.
    class Trace
      Step = Struct.new(
        :index,
        :kind,
        :description,
        :url_before,
        :url_after,
        :dom_after,    # only the post-action snapshot — the previous step's `dom_after` is the implicit "before"
        :console,
        :network,
        :elapsed_ms,
        :duration_ms,
        :error,
        keyword_init: true
      )

      attr_reader :steps, :metadata

      def initialize(metadata: {})
        @steps        = []
        @metadata     = metadata
        @started_at   = monotonic_ms
        @console_buf  = []
        @network_buf  = []
        @open_step    = nil
      end

      # Pushed from `Browser#log_console` (the JS bridge's `console.*`
      # host-fn target) and `Browser#rack_request` (network). Entries
      # land on the currently-open step; outside a step they're dropped
      # (boot noise, post-test cleanup).
      def log_console(severity, message)
        return unless @open_step
        @console_buf << {severity: severity.to_s, message: message.to_s}
      end

      def log_network(method, url, status)
        return unless @open_step
        @network_buf << {method: method.to_s, url: url.to_s, status: status}
      end

      def begin_step(kind, description:, url_before: nil)
        finish_step if @open_step
        @open_step = {
          kind:        kind,
          description: description,
          url_before:  url_before,
          start_ms:    monotonic_ms
        }
        @console_buf = []
        @network_buf = []
      end

      def finish_step(url_after: nil, dom_after: nil, error: nil)
        return unless @open_step
        s = @open_step
        @steps << Step.new(
          index:        @steps.size,
          kind:         s[:kind],
          description:  s[:description],
          url_before:   s[:url_before],
          url_after:    url_after,
          dom_after:    dom_after,
          console:      @console_buf,
          network:      @network_buf,
          elapsed_ms:   (s[:start_ms] - @started_at).round,
          duration_ms:  (monotonic_ms - s[:start_ms]).round,
          error:        error
        )
        @open_step   = nil
        @console_buf = []
        @network_buf = []
      end

      def empty? = @steps.empty?

      def to_h
        {version: 1, metadata: @metadata, steps: @steps.map(&:to_h)}
      end

      def to_json(*args) = JSON.generate(to_h, *args)

      def write_json(path)
        FileUtils.mkdir_p(File.dirname(path))
        File.write(path, to_json)
        path
      end

      private

      def monotonic_ms
        Process.clock_gettime(Process::CLOCK_MONOTONIC) * 1000.0
      end
    end
  end
end
