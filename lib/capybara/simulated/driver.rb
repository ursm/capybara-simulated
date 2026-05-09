# frozen_string_literal: true

require 'capybara/driver/base'
require_relative 'browser'
require_relative 'node'

module Capybara
  module Simulated
    class Driver < Capybara::Driver::Base
      attr_reader :app

      # `features` is appended to the QuickJS feature flags the runtime
      # already pins (URL / Encoding / Crypto). Pass e.g.
      # `[Quickjs::POLYFILL_INTL]` from your `register_driver` block to
      # surface `Intl.DateTimeFormat` etc. inside the JS sandbox.
      class << self
        # `Capybara.current_session.driver` is unreliable from RSpec
        # hooks — hosts swap sessions via `using_session` blocks, so by
        # the time `after(:each)` runs the active session is often back
        # to `:rack_test`. The auto-trace hook in `support/csim_rspec.rb`
        # reads this slot instead so it can always find the live driver.
        attr_accessor :current
      end

      def initialize(app, features: [])
        @app      = app
        @features = features
        self.class.current = self
      end

      # Per-test trace recording. Mirrors capybara-playwright-driver's
      # `start_tracing` / `stop_tracing` shape so suites can swap drivers
      # without rewriting hooks. Keyword args are stashed verbatim into
      # the trace's metadata.
      def start_tracing(**metadata)
        browser.start_trace(metadata)
      end

      # With `path:`, persist the active trace as JSON and clear it.
      # Without, return the trace object for in-memory inspection.
      # Falls back to `Browser#pending_trace` because Capybara runs its
      # per-test session reset *before* user `after(:each)` hooks — by
      # the time RSpec teardown sees the driver, the live slot has
      # already been moved to `pending`.
      def stop_tracing(path: nil)
        active = current_trace or return nil
        result = path ? browser.finish_trace_to(path, active) : active
        browser.clear_trace!
        result
      end

      def tracing?     = !current_trace.nil?
      def current_trace = browser.trace || browser.pending_trace

      def browser
        @browser ||= Browser.new(app, features: @features)
      end

      def needs_server?       = false
      def javascript_enabled? = true
      # Dynamic `wait?`: only ask Capybara to poll when there's actually
      # pending JS work that real-time advancement could resolve. With
      # no timers queued, polling cannot change anything — fail fast
      # via the `wait? = false` synchronize path. Once polling starts
      # we stay sticky for a window so a setTimeout firing mid-loop
      # doesn't drop us off the polling path before Capybara's own
      # `default_max_wait_time` expires.
      def wait? = browser.polling?

      def visit(path)      = browser.visit(path)
      def refresh          = browser.refresh
      def reset!           = browser.reset!
      def go_back          = browser.go_back
      def go_forward       = browser.go_forward

      # Rack-test parity: `Capybara.current_session.driver.header(name, value)`
      # sets a header to be sent on every subsequent request for the
      # lifetime of the session. Forem's `ForemWebView` specs use this
      # to flip `User-Agent` so the rendered page picks the mobile
      # registration UI variant.
      def header(name, value) = browser.set_header(name, value)
      def current_url      = browser.current_url || ''
      def html             = browser.html

      # Capybara wires `save_screenshot` through the driver. Without a
      # raster engine we can't produce a PNG, but spec teardown hooks
      # ("dump on failure" plumbing) typically just want *something* at
      # the requested path; writing the live HTML there keeps the
      # debugging path useful and avoids the secondary
      # `NotSupportedByDriverError` that masks the real failure.
      def save_screenshot(path, **_opts)
        File.write(path, browser.html.to_s)
        path
      end

      # Cuprite / Selenium expose `driver.resize(w, h)` to drive
      # responsive-design tests. We don't lay anything out, but the
      # call still moves the cascade's `@media` evaluation context —
      # rules behind `(max-width: 768px)` etc. flip on/off when the
      # test sizes the viewport into / out of a breakpoint.
      def resize(width, height) = browser.set_viewport(width, height)
      def resize_window_to(_handle, width, height) = browser.set_viewport(width, height)
      def maximize_window(_handle); end

      # We don't model windows / tabs — there's only the one document.
      # But Capybara's `current_window.resize_to(w, h)` and similar
      # session-level helpers walk through `current_window_handle`, so
      # without these any responsive-test that goes via the
      # `Capybara::Window` API blows up before the resize lands.
      WINDOW_HANDLE = 'csim-window-0'
      def current_window_handle  = WINDOW_HANDLE
      def window_handles         = [WINDOW_HANDLE]
      def window_size(_handle)   = [browser.viewport_width, browser.viewport_height]
      def close_window(_handle); end
      def switch_to_window(_handle); end
      def title            = browser.title
      def status_code      = browser.status_code
      def response_headers = browser.response_headers

      def active_element
        handle = browser.active_element_handle
        handle ? Node.new(self, handle) : nil
      end

      # Session-level send_keys: routes :tab / :shift+:tab through the
      # focus order, otherwise targets the active element.
      def send_keys(*keys)
        browser.session_send_keys(keys)
      end

      def accept_modal(type, **options, &block)
        run_modal(type, accept: true, **options, &block)
      end

      def dismiss_modal(type, **options, &block)
        run_modal(type, accept: false, **options, &block)
      end

      private

      def run_modal(type, accept:, text: nil, with: nil, wait: nil, &block)
        captured = nil
        # Selenium / cuprite respond by *modal*, not by the helper
        # name — `accept_alert do ... end` accepts confirm() and
        # prompt() too. Dispatch by the actual modal type fired,
        # not by the helper's `type` argument.
        handler = ->(actual_type, msg, default_value) {
          captured = msg
          modal_response(actual_type, accept, with, default_value)
        }
        browser.with_modal(handler, &block)
        if captured.nil?
          raise Capybara::ModalNotFound, "Unable to find modal dialog with #{text.inspect}"
        end
        if text && !modal_text_matches?(text, captured)
          raise Capybara::ModalNotFound,
            "Unable to find modal dialog with #{text.inspect} (got #{captured.inspect})"
        end
        captured
      end

      def modal_response(actual_type, accept, with, default_value)
        case actual_type.to_sym
        when :alert   then nil
        when :confirm then accept
        when :prompt
          return nil unless accept
          with.nil? ? default_value.to_s : with.to_s
        end
      end

      def modal_text_matches?(matcher, message)
        matcher.is_a?(Regexp) ? matcher.match?(message) : message.include?(matcher.to_s)
      end

      public

      def find_xpath(query, **_)
        browser.find_xpath(query).map { |id| Node.new(self, id) }
      end

      def evaluate_script(script, *args)
        unwrap_script_result(browser.evaluate_script(script, args))
      end

      # Same wire path; Capybara's contract is that execute_script
      # discards the result.
      def execute_script(script, *args)
        browser.evaluate_script(script, args)
        nil
      end

      def evaluate_async_script(script, *args)
        unwrap_script_result(browser.evaluate_async_script(script, args))
      end

      def find_css(query, **_)
        browser.find_css(query).map { |id| Node.new(self, id) }
      end

      # Capybara's synchronize wrapper catches anything in this list and
      # retries the action after `reload` if automatic_reload is on. We
      # expose the stale-element class so a node detached by a JS
      # `replaceWith` / `removeChild` triggers Capybara's reload path.
      def invalid_element_errors
        [Capybara::Simulated::StaleElement]
      end

      def no_such_window_error
        Capybara::WindowError
      end

      private

      def unwrap_script_result(value)
        case value
        when Hash
          if (h = value['__elementHandle'])
            Node.new(self, h)
          else
            value.transform_values { |v| unwrap_script_result(v) }
          end
        when Array
          value.map { |v| unwrap_script_result(v) }
        else
          value
        end
      end
    end
  end
end
