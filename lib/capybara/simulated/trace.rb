# frozen_string_literal: true

require 'json'
require 'fileutils'

module Capybara
  module Simulated
    # Per-test trace of Capybara actions with DOM snapshots, screenshots,
    # console output, and network requests interleaved. JSON output, one
    # file per test — downstream tooling builds whatever viewer it wants.
    #
    # A screenshot is carried INLINE as a data URL, like everything else here:
    # the viewer's whole point is that it opens from `file://` with no server,
    # and a side-file image would need one (or a second artefact to lose).
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
        :shot_after,   # …and the same moment PAINTED, as a `data:image/png;base64,…` URL
        :console,
        :network,
        :elapsed_ms,
        :duration_ms,
        :error,
        keyword_init: true
      )

      VIEWER_TEMPLATE_PATH = File.expand_path('trace_viewer.html', __dir__)
      VIEWER_DATA_TOKEN    = '__CSIM_TRACE_DATA__'

      # Render the self-contained HTML viewer for a trace JSON *string*,
      # embedding it inline (the `capybara-simulated trace` CLI is the
      # caller). `</` → `<\/` so an embedded `</script>` inside a DOM
      # snapshot can't close the data block early — still valid JSON
      # (`\/` is a legal JSON escape for `/`). The whole point of inline
      # embedding over fetch / `import … with { type: 'json' }` is that
      # the result opens straight from `file://` with no server (module /
      # fetch loads are CORS-blocked for `file://` origins).
      def self.render_viewer(json_text)
        template = (@viewer_template ||= File.read(VIEWER_TEMPLATE_PATH))
        # Block form: the replacement is taken literally, so backslashes
        # in the JSON aren't interpreted as regexp backreferences.
        template.sub(VIEWER_DATA_TOKEN) { json_text.to_s.gsub('</', '<\/') }
      end

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

      def log_network(method, url, status,
                      content_type: nil, size: nil, duration_ms: nil, redirected: nil,
                      request_headers: nil, request_body: nil,
                      response_headers: nil, response_body: nil)
        return unless @open_step
        @network_buf << {
          method:           method.to_s,
          url:              url.to_s,
          status:           status,
          content_type:     content_type,
          size:             size,
          duration_ms:      duration_ms,
          redirected:       redirected,
          request_headers:  request_headers,
          request_body:     request_body,
          response_headers: response_headers,
          response_body:    response_body
        }.compact  # drop fields the caller couldn't determine, keeping entries lean
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

      def finish_step(url_after: nil, dom_after: nil, shot_after: nil, error: nil)
        return unless @open_step
        s = @open_step
        @steps << Step.new(
          index:        @steps.size,
          kind:         s[:kind],
          description:  s[:description],
          url_before:   s[:url_before],
          url_after:    url_after,
          dom_after:    dom_after,
          shot_after:   shot_after,
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

      # Is the step just recorded another attempt at the SAME failing action? Capybara retries an
      # action for its whole wait window, and every attempt records a step — so this is what keeps
      # a screenshot from being painted 60 times for one failed click.
      def retrying_failure?(kind, description)
        last = @steps.last
        !last.nil? && !last.error.nil? && last.kind == kind && last.description == description
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
