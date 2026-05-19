# frozen_string_literal: true

require 'capybara/driver/base'
require 'weakref'
require_relative 'browser'
require_relative 'node'

module Capybara
  module Simulated
    # User-intent `sleep(n)` from a test forwards to the active driver
    # so any `setTimeout(n')` callbacks the user is waiting on fire on
    # the next tick. The JS clock is otherwise wall-clock-independent
    # for determinism; this is the bridge that lets `reload`-style
    # specs still pace via `sleep`.
    #
    # Capybara's internal `sleep(retry_interval)` is 10–50 ms and
    # doesn't represent test-author intent; forwarding it would add
    # per-poll drain overhead. Test pacing sleeps (e.g. `sleep(0.3)`)
    # land above the threshold.
    USER_SLEEP_THRESHOLD_S = 0.1
    module SleepHook
      def sleep(seconds = nil)
        return super if seconds.nil?
        n = super
        if seconds.to_f >= Capybara::Simulated::USER_SLEEP_THRESHOLD_S
          # Advance every live driver. Multiple sessions can coexist
          # within a suite (e.g. `let(:session)` makes a new one per
          # example, while the shared-spec session is module-level),
          # and a single thread-local "current" slot races: whichever
          # Driver was constructed last wins the slot even when a
          # different one is actually driving the spec right now.
          # Idle drivers no-op (`tick_real_time` short-circuits when
          # `@timers_active` is false), so a blanket advance is
          # correct AND cheap.
          ms = (seconds.to_f * 1000).to_i
          Capybara::Simulated::Driver.each_live {|d| d.browser.advance_virtual_clock_ms(ms) }
        end
        n
      end
    end
    Kernel.prepend(SleepHook)

    class Driver < Capybara::Driver::Base
      attr_reader :app

      @@live_lock = Mutex.new
      @@live      = []  # [WeakRef<Driver>] — dead refs filtered on read.

      def self.each_live
        @@live_lock.synchronize {
          @@live.reject! {|ref| !ref.weakref_alive? }
          @@live.dup
        }.each {|ref|
          d = ref.__getobj__ rescue nil
          yield d if d
        }
      end

      def initialize(app, js_engine: nil)
        @app             = app
        @browser         = Browser.new(app, driver: self, js_engine: js_engine)
        @aux_windows     = []  # [{handle:, url:}, …]  URL-only mode
        @active_handle   = nil
        @next_window_seq = 0
        @@live_lock.synchronize { @@live << WeakRef.new(self) }
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

      # Playwright-driver compatibility shim. Discourse's system-spec
      # `before(:each)` calls `page.driver.with_playwright_page` to
      # install a JS-console logger and apply a CDP `setTimezoneOverride`;
      # both are Playwright-specific machinery we don't have an analogue
      # for. No-op (don't yield) so the surrounding hook is a graceful
      # skip when the upstream block dereferences the yielded page.
      def with_playwright_page; end
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
      # (Avo's `open_field_attachment` test).
      PRIMARY_HANDLE = 'csim-window-0'
      def current_window_handle    = @active_handle || PRIMARY_HANDLE
      def window_handles
        [PRIMARY_HANDLE] + @aux_windows.map {|w| w[:handle] }
      end
      def open_aux_window(url)
        @next_window_seq += 1
        handle = "csim-window-#{@next_window_seq}"
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
      # rather than through `current_window.resize_to`.
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
    end
  end
end
