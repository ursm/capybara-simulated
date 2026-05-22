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
          # Broadcast to every Driver constructed on the current
          # thread. Background threads (`MessageBus::TimerThread`,
          # etc.) sleep too, but their Drivers — if any — were
          # registered under a different thread, so they skip; the
          # filter is load-bearing because mini_racer / quickjs.rb
          # VMs aren't thread-safe. Idle Drivers no-op
          # (`tick_real_time` short-circuits when `@timers_active`
          # is false), so the broadcast is cheap.
          ms = (seconds.to_f * 1000).to_i
          Capybara::Simulated::Driver.each_live_on_thread(Thread.current) {|d|
            d.browser.advance_virtual_clock_ms(ms)
          }
        end
        n
      end
    end
    Kernel.prepend(SleepHook)

    class Driver < Capybara::Driver::Base
      attr_reader :app, :owner_thread

      @@live_lock = Mutex.new
      @@live      = []  # [WeakRef<Driver>] — dead refs filtered on read.

      def self.each_live_on_thread(thread)
        drivers = @@live_lock.synchronize {
          @@live.select!(&:weakref_alive?)
          @@live.filter_map {|ref| ref.__getobj__ rescue nil }
        }
        drivers.each {|d| yield d if d.owner_thread == thread }
      end

      # `viewport: [w, h]` (or via `Capybara.register_driver` block)
      # forces the JS-side `innerWidth`/`innerHeight` before the first
      # navigate, so `matchMedia` / mobile-breakpoint branches resolve
      # before any document loads.
      def initialize(app, js_engine: nil, viewport: nil)
        @app             = app
        @browser         = Browser.new(app, driver: self, js_engine: js_engine)
        @aux_windows     = []  # [{handle:, url:}, …]  URL-only mode
        @active_handle   = nil
        @next_window_seq = 0
        @owner_thread    = Thread.current
        @@live_lock.synchronize { @@live << WeakRef.new(self) }
        @browser.set_viewport(*viewport) if viewport
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
      # install a JS-console logger, apply a CDP `setTimezoneOverride`,
      # and (in dev_tools_spec) evaluate `window.enableDevTools()`.
      # Yield a `FakePlaywrightPage` that delegates `evaluate(js)` to
      # our JS engine and silently no-ops every other Playwright-only
      # method via `method_missing → self`. Chained accessors like
      # `pw.context.new_cdp_session(pw).send_message("…")` therefore
      # propagate as a no-op rather than NoMethodError, while
      # `pw.evaluate("…")` runs the JS where it matters.
      def with_playwright_page
        yield FakePlaywrightPage.new(browser) if block_given?
      end

      class FakePlaywrightPage
        def initialize(browser) = (@browser = browser)
        def evaluate(js, *)     = @browser.evaluate_script(js.to_s)
        def respond_to_missing?(*) = true
        # Yield to the block when one is given so Playwright methods
        # whose semantics live entirely in their block (the canonical
        # case is `pw_page.expect_download { click_link "…" }` —
        # `expect_download` arms a download watcher, *then* runs the
        # block, *then* awaits the watcher). Returning `self` from a
        # block-taking method-missing would skip the block entirely
        # and the download never triggers. Pass the receiver in as
        # the block argument so chained `|d| d.suggested_filename`
        # readers see a no-op object.
        def method_missing(*)
          yield self if block_given?
          self
        end
      end
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
        # Selenium contract: a nested Array is a *chord* — modifiers
        # combined with the final key in one press (`send_keys([
        # :control, "/"])` = Ctrl-/). Passing through `flatten.each`
        # iterates each token separately and loses the combo, so the
        # JS-side handler sees `:control` then `"/"` as two unrelated
        # presses. Pass top-level items intact; `send_session_key`
        # forwards Arrays as-is to `Browser#send_keys` which converts
        # them to `kind=combo` atoms.
        keys.each {|k| browser.send_session_key(k) }
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
