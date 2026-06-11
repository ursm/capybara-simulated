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
          # filter is load-bearing because rusty_racer / quickjs.rb
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

      # `viewport: [w, h]` and `user_agent:` (typically supplied via
      # `Capybara.register_driver`) force the JS-side
      # `innerWidth`/`innerHeight` and `navigator.userAgent` (plus
      # `HTTP_USER_AGENT` on Rack requests) before the first navigate,
      # so `matchMedia` / mobile-breakpoint branches and server-side
      # UA-based mobile detection both resolve before any document
      # loads. The Browser tracks both as "defaults" so `reset!`
      # (per-test teardown) restores them between specs.
      def initialize(app, js_engine: nil, viewport: nil, user_agent: nil)
        @app             = app
        @js_engine       = js_engine
        # Cookies + localStorage are origin-shared across windows
        # (real browser semantics), so we own the jars at the Driver
        # level and inject them into every per-window Browser. Each
        # Browser still has its own sessionStorage + DOM + JS VM.
        @cookies         = {}
        @local_storage   = {}
        @browser         = build_window_browser
        @aux_windows     = []  # [{handle:, browser:}, …]
        @active_handle   = nil
        @next_window_seq = 0
        @owner_thread    = Thread.current
        @@live_lock.synchronize { @@live << WeakRef.new(self) }
        @browser.default_viewport   = viewport   if viewport
        @browser.default_user_agent = user_agent if user_agent
      end

      private def build_window_browser
        Browser.new(@app,
                    driver:        self,
                    js_engine:     @js_engine,
                    cookies:       @cookies,
                    local_storage: @local_storage)
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

      # Active window's Browser. Primary by default; switches when the
      # test calls `switch_to_window(aux_handle)`. Every DOM / URL /
      # JS-touching driver method routes through here so per-window
      # state (DOM, sessionStorage, history) stays window-scoped.
      def current_browser
        return @browser unless @active_handle
        w = @aux_windows.find {|win| win[:handle] == @active_handle }
        w ? w[:browser] : @browser
      end

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
        yield FakePlaywrightPage.new(current_browser) if block_given?
      end

      class FakePlaywrightPage
        def initialize(browser) = (@browser = browser)
        # Playwright's `page.evaluate` takes either a string expression
        # or a function literal — when given a function it calls it
        # and returns the result. The simulated driver's underlying
        # `evaluate_script` just runs the source as an expression, so
        # a function-literal payload would return the function object
        # instead of its return value. Wrap arrow-function-shaped
        # bodies in `(...)()` so the function is invoked and the test
        # sees its result.
        def evaluate(js, *)
          src = js.to_s.strip
          src = "(#{src})()" if src.match?(/\A(\(?\s*(async\s+)?(\(.*?\)|\w+)\s*=>|\(?\s*(async\s+)?function\s*\*?\s*\()/m)
          @browser.evaluate_script(src)
        end
        # `pw_page.locator(selector)` returns a Locator that proxies
        # click / fill / count / etc. through Capybara's current
        # session. Discourse's SelectKit / system_helpers `locator`
        # method drives the suspend / silence / penalize / dropdown
        # chains via `pw_page.locator(...).click` — without a real
        # locator the click is a no-op and the modal never advances.
        def locator(selector) = FakePlaywrightLocator.new(selector)
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

      class FakePlaywrightLocator
        def initialize(selector, scope = nil)
          @selector = selector
          @scope    = scope
        end
        def locator(child)    = FakePlaywrightLocator.new(child, self)
        def click             = node.click
        def fill(value)       = node.set(value)
        def click_via_js      = node.click
        def count             = nodes.size
        def first             = FakePlaywrightLocator.new("#{@selector}:first-of-type", @scope)
        def text_content      = node.text
        def inner_text        = node.text
        def visible?          = node.visible?
        def hover             = node.hover
        def press(key)        = node.send_keys(key)
        def get_attribute(name) = node[name]
        def all               = nodes.each_with_index.map {|_, i| FakePlaywrightLocator.new("#{@selector}:nth-of-type(#{i + 1})", @scope) }
        private
        def session = Capybara.current_session
        def context = @scope ? @scope.send(:node) : session
        def node    = context.find(:css, @selector)
        def nodes   = context.all(:css, @selector)
      end
      # Dynamic wait?: only poll when there's pending timer work that
      # real-time advancement could resolve. With no timers queued,
      # polling can't change anything, so we fail fast via the
      # `wait? = false` synchronize path.
      def wait?               = current_browser.polling?

      def visit(path)          = current_browser.visit(path)
      def refresh              = current_browser.refresh
      def reset!
        @aux_windows.each {|w| w[:browser].dispose rescue nil }
        @aux_windows.clear
        @active_handle = nil
        browser.reset!
      end
      def go_back              = current_browser.go_back
      def go_forward           = current_browser.go_forward
      def current_url          = current_browser.current_url || ''
      def html                 = current_browser.html
      def title                = current_browser.title
      def status_code          = current_browser.status_code
      def response_headers     = current_browser.response_headers
      def header(name, value)  = current_browser.set_header(name, value)

      def find_xpath(query, **_)
        current_browser.find_xpath(query).map {|id| Node.new(self, id) }
      end

      def find_css(query, **_)
        current_browser.find_css(query).map {|id| Node.new(self, id) }
      end

      # Per-window Browser/VM. `open_aux_window` creates a fresh
      # Browser sharing the Driver's cookie + localStorage jars
      # (origin-shared in real browsers) and visits the target URL;
      # `switch_to_window` flips `@active_handle` so subsequent driver
      # ops route through `current_browser`. sessionStorage + DOM +
      # history + the JS VM stay per-window.
      PRIMARY_HANDLE = 'csim-window-0'
      def current_window_handle    = @active_handle || PRIMARY_HANDLE
      def window_handles
        [PRIMARY_HANDLE] + @aux_windows.map {|w| w[:handle] }
      end
      def open_aux_window(url = nil)
        @next_window_seq += 1
        handle = "csim-window-#{@next_window_seq}"
        aux = build_window_browser
        aux.visit(url) if url && !url.empty?
        @aux_windows << {handle: handle, browser: aux}
        handle
      rescue StandardError => e
        # Aux window URL-load failure (binary content, network error,
        # …) shouldn't tear down the test — record the handle so
        # `window_opened_by` succeeds; within_window assertions on
        # `current_url` may still pass through whatever `visit`
        # managed to set before raising.
        warn "[csim] open_aux_window(#{url.inspect}) raised: #{e.class}: #{e.message[0, 200]}"
        @aux_windows << {handle: handle, browser: aux}
        handle
      end

      # Capybara `Session#open_new_window(:tab)` entry point — visits
      # `about:blank` so the test can `switch_to_window` then `visit`
      # the real URL. We don't distinguish `:tab` from `:window` (no
      # window-chrome semantics in this driver).
      def open_new_window(_kind = :tab)
        open_aux_window
      end
      def window_size(_)           = [current_browser.viewport_width, current_browser.viewport_height]
      def close_window(h)
        return if h == PRIMARY_HANDLE
        @aux_windows.reject! {|w|
          next false unless w[:handle] == h
          w[:browser].dispose rescue nil
          true
        }
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
      def resize_window_to(_, w, h) = current_browser.set_viewport(w, h)
      # Forem's ahoy-tracking spec calls `driver.resize(w, h)` directly
      # rather than through `current_window.resize_to`.
      def resize(w, h) = current_browser.set_viewport(w, h)
      def maximize_window(_)       ; nil ; end

      def evaluate_script(script, *args)
        unwrap(current_browser.evaluate_script(script, args))
      end

      # Capybara's `execute_script` contract is "run it, discard the
      # return". Route through a no-return JS path so a script that
      # returns a non-marshallable value (jQuery `$('…').text('…')`
      # returns a chainable jQuery object that the engine's value
      # filter recurses into until it stack-overflows) doesn't blow
      # up on the way back.
      def execute_script(script, *args)
        current_browser.execute_script(script, args)
        nil
      end

      def evaluate_async_script(script, *args)
        unwrap(current_browser.evaluate_async_script(script, args))
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
        File.write(path, current_browser.html.to_s)
        path
      end

      def active_element
        handle = current_browser.active_element_handle
        handle ? Node.new(self, handle) : nil
      end

      # CDP-ish geolocation override (Capybara driver-level API).
      #
      #   page.driver.set_geolocation(latitude: 35.6, longitude: 139.7)
      #   page.driver.set_geolocation(denied: true)  # PERMISSION_DENIED
      #   page.driver.set_geolocation                # clear -> POSITION_UNAVAILABLE
      def set_geolocation(latitude: nil, longitude: nil, accuracy: 10, denied: false, **rest)
        current_browser.set_geolocation(latitude: latitude, longitude: longitude, accuracy: accuracy, denied: denied, **rest)
      end

      def send_keys(*keys)
        # Selenium contract: top-level modifier symbols (`send_keys(
        # :shift, :enter)`) press the modifier *and hold it* over the
        # following key, releasing at the end of the call. Nested
        # arrays (`send_keys([:control, "/"])`) are chords — modifiers
        # combined with the final key in one press. Pass the whole
        # batch to `Browser#send_session_keys` in one call so the
        # JS-side handler can build a `combo` atom from the held
        # modifiers + the next key. Iterating per-key would split the
        # chord across calls and drop the modifier flags.
        current_browser.send_session_keys(keys)
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
        current_browser.with_modal(handler) do
          yield if block_given?
          # Pump timers so a setTimeout-driven alert can land.
          timeout = (wait || Capybara.default_max_wait_time).to_f
          deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
          while captured.nil? && Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
            sleep 0.01
            current_browser.send(:tick_real_time)
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
