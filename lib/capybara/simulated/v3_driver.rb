# frozen_string_literal: true

# v3 Driver: deliberately *not* a subclass of v2 `Driver`. v2's Driver
# carries multi-window state, modal-handler plumbing, tracing hooks,
# and v2-Browser-specific window construction that the v3 PoC doesn't
# need yet (and shouldn't pretend to). This keeps v2 free of "if v3"
# branches and v3 free of carry-over surface it hasn't earned.

require 'capybara/driver/base'
require_relative 'v3_browser'
require_relative 'v3_node'

module Capybara
  module Simulated
    class V3Driver < Capybara::Driver::Base
      attr_reader :app

      def initialize(app)
        @app     = app
        @browser = V3Browser.new(app)
      end

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
      def reset!               = browser.reset!
      def go_back              = browser.go_back
      def go_forward           = browser.go_forward
      def current_url          = browser.current_url || ''
      def html                 = browser.html
      def title                = browser.title
      def status_code          = browser.status_code
      def response_headers     = browser.response_headers
      def header(name, value)  = browser.set_header(name, value)

      def find_xpath(query, **_)
        browser.find_xpath(query).map {|id| V3Node.new(self, id) }
      end

      def find_css(query, **_)
        browser.find_css(query).map {|id| V3Node.new(self, id) }
      end

      # Single-window PoC. open_aux_window / switch_to_window land with
      # milestone 5+ once the basic surface is solid.
      PRIMARY_HANDLE = 'csim-v3-window-0'
      def current_window_handle    = PRIMARY_HANDLE
      def window_handles           = [PRIMARY_HANDLE]
      def window_size(_)           = [browser.viewport_width, browser.viewport_height]
      def close_window(_)          ; nil ; end
      def switch_to_window(_)      ; nil ; end
      def resize_window_to(_, w, h) = browser.set_viewport(w, h)
      def maximize_window(_)       ; nil ; end

      def evaluate_script(script, *args)
        unwrap(browser.evaluate_script(script, args))
      end

      # Capybara's `execute_script` contract is "run it, discard the
      # return". Same wire path; we just throw the result away.
      def execute_script(script, *args)
        browser.evaluate_script(script, args)
        nil
      end

      def evaluate_async_script(script, *args)
        unwrap(browser.evaluate_async_script(script, args))
      end

      private def unwrap(value)
        case value
        when Hash
          if (h = value['__elementHandle']) then V3Node.new(self, h)
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
        handle ? V3Node.new(self, handle) : nil
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
