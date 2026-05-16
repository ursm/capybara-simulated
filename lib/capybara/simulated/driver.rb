# frozen_string_literal: true

require 'capybara/driver/base'
require_relative 'browser'
require_relative 'node'

module Capybara
  module Simulated
    class Driver < Capybara::Driver::Base
      attr_reader :app

      class << self
        # Thread-local "active driver" for the auto-trace RSpec /
        # Minitest hooks. Capybara's `using_session` swaps the active
        # session inside tests; by after-hook time the live session
        # may not be `:simulated` any more, so the hook reads from this
        # slot instead of from `Capybara.current_session`.
        def current = Thread.current[:capybara_simulated_driver]
        def current=(d)
          Thread.current[:capybara_simulated_driver] = d
        end
      end

      def initialize(app)
        @app             = app
        @browser         = Browser.new(app, driver: self)
        @aux_windows     = []  # [{handle:, url:}, …]  URL-only mode
        @active_handle   = nil
        @next_window_seq = 0
        self.class.current = self
      end

      # Per-test trace recording. Mirrors capybara-playwright-driver's
      # `start_tracing` / `stop_tracing` shape so suites can swap
      # drivers without rewriting hooks.
      def start_tracing(**metadata) = browser.start_trace(metadata)

      def stop_tracing(path: nil)
        active = current_trace or return nil
        result = path ? browser.finish_trace_to(path, active) : active
        browser.clear_trace!
        result
      end

      def tracing?      = !current_trace.nil?
      def current_trace = browser.trace || browser.pending_trace

      attr_reader :browser
      alias current_browser browser

      def needs_server?       = false
      def javascript_enabled? = true
      # Dynamic wait?: only poll when there's pending timer work that
      # real-time advancement could resolve. With no timers queued,
      # polling can't change anything, so we fail fast via the
      # `wait? = false` synchronize path.
      def wait?               = browser.polling?

      def visit(path)          = browser.visit(path)
      def refresh              = browser.refresh
      def reset!
        @aux_windows.clear
        @active_handle = nil
        browser.reset!
      end
      def go_back              = browser.go_back
      def go_forward           = browser.go_forward
      def current_url
        if @active_handle && (w = @aux_windows.find {|win| win[:handle] == @active_handle })
          return w[:url].to_s
        end
        browser.current_url || ''
      end
      def html                 = browser.html
      def title                = browser.title
      def status_code          = browser.status_code
      def response_headers     = browser.response_headers
      def header(name, value)  = browser.set_header(name, value)

      def find_xpath(query, **_)
        browser.find_xpath(query).map {|id| Node.new(self, id) }
      end

      def find_css(query, **_)
        browser.find_css(query).map {|id| Node.new(self, id) }
      end

      # URL-only multi-window: `<a target="_blank">` clicks record an
      # aux window {handle, url} pair. Aux windows have no JS VM and no
      # DOM — `page.current_url` works inside `within_window`, but DOM
      # queries don't. Sufficient for "PDF opens in new tab" assertions
      # (Avo's `open_field_attachment` test). Full per-window VMs were
      # in v2 (`Driver#open_aux_window`); v3 defers them until a real
      # test needs more than URL tracking.
      PRIMARY_HANDLE = 'csim-v3-window-0'
      def current_window_handle    = @active_handle || PRIMARY_HANDLE
      def window_handles
        [PRIMARY_HANDLE] + @aux_windows.map {|w| w[:handle] }
      end
      def open_aux_window(url)
        @next_window_seq += 1
        handle = "csim-v3-window-#{@next_window_seq}"
        @aux_windows << {handle: handle, url: url}
        handle
      end
      def window_size(_)           = [browser.viewport_width, browser.viewport_height]
      def close_window(h)
        return if h == PRIMARY_HANDLE
        @aux_windows.reject! {|w| w[:handle] == h }
        @active_handle = nil if @active_handle == h
      end
      def switch_to_window(h)
        if h == PRIMARY_HANDLE
          @active_handle = nil
        elsif @aux_windows.any? {|w| w[:handle] == h }
          @active_handle = h
        else
          raise Capybara::WindowError, "Unknown window handle: #{h}"
        end
      end
      def resize_window_to(_, w, h) = browser.set_viewport(w, h)
      # Forem's ahoy-tracking spec calls `driver.resize(w, h)` directly
      # rather than through `current_window.resize_to`; mirror v2 by
      # exposing the same shortcut.
      def resize(w, h) = browser.set_viewport(w, h)
      def maximize_window(_)       ; nil ; end

      def evaluate_script(script, *args)
        unwrap(browser.evaluate_script(script, args))
      end

      # Capybara's `execute_script` contract is "run it, discard the
      # return". Route through a no-return JS path so a script that
      # returns a non-marshallable value (jQuery `$('…').text('…')`
      # returns a chainable jQuery object that mini_racer's value
      # filter recurses into until it stack-overflows) doesn't blow
      # up on the way back.
      def execute_script(script, *args)
        browser.execute_script(script, args)
        nil
      end

      def evaluate_async_script(script, *args)
        unwrap(browser.evaluate_async_script(script, args))
      end

      private def unwrap(value)
        case value
        when Hash
          if (h = value['__elementHandle']) then Node.new(self, h)
          else value.transform_values {|v| unwrap(v) }
          end
        when Array then value.map {|v| unwrap(v) }
        else value
        end
      end
      public

      def invalid_element_errors = [Capybara::Simulated::StaleElement]
      def no_such_window_error   = Capybara::WindowError

      def save_screenshot(path, **_opts)
        File.write(path, browser.html.to_s)
        path
      end

      def active_element
        handle = browser.active_element_handle
        handle ? Node.new(self, handle) : nil
      end
      def send_keys(*keys)
        keys.flatten.each {|k| browser.send_session_key(k) }
        nil
      end

      def accept_modal(type, **options, &block) = run_modal(type, accept: true, **options, &block)
      def dismiss_modal(type, **options, &block) = run_modal(type, accept: false, **options, &block)

      private def run_modal(type, accept:, text: nil, with: nil, wait: nil)
        captured = nil
        # Dispatch by the *actual* modal type fired — `accept_alert
        # do ... end` should also accept a confirm() raised by the
        # block. Mirrors how selenium / cuprite route in real life.
        handler = ->(actual_type, msg, default_value) {
          captured = msg
          case actual_type.to_sym
          when :alert   then nil
          when :confirm then accept
          when :prompt  then accept ? (with.nil? ? default_value.to_s : with.to_s) : nil
          end
        }
        browser.with_modal(handler) do
          yield if block_given?
          # Pump timers so a setTimeout-driven alert can land.
          timeout = (wait || Capybara.default_max_wait_time).to_f
          deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
          while captured.nil? && Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
            sleep 0.01
            browser.send(:tick_real_time)
          end
        end
        if captured.nil?
          raise Capybara::ModalNotFound, "Unable to find modal dialog with #{text.inspect}"
        end
        if text && !modal_text_matches?(text, captured)
          raise Capybara::ModalNotFound,
            "Unable to find modal dialog with #{text.inspect} (got #{captured.inspect})"
        end
        captured
      end

      private def modal_text_matches?(matcher, message)
        matcher.is_a?(Regexp) ? matcher.match?(message) : message.include?(matcher.to_s)
      end
      public
    end
  end
end
