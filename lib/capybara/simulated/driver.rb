# frozen_string_literal: true

require 'capybara/driver/base'
require 'capybara/server/animation_disabler'
require 'weakref'
require_relative 'browser'
require_relative 'realm_window'
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
          # filter is load-bearing because rusty_racer VMs aren't
          # thread-safe. Idle Drivers no-op
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

      # Every driver still live at exit is disposed — its windows', workers' and sockets' threads stopped the way a
      # dropped session's are — before V8Runtime's sweep disposes the isolates (this hook, registered after that one,
      # runs first). A worker's isolate disposed from the main thread while its own thread still waits on its inbox
      # hung the process's exit.
      at_exit do
        drivers = @@live_lock.synchronize { @@live.filter_map {|ref| ref.__getobj__ rescue nil } }
        drivers.each {|d| d.dispose rescue nil }
      end

      def self.each_live_on_thread(thread)
        drivers = @@live_lock.synchronize {
          @@live.select!(&:weakref_alive?)
          @@live.filter_map {|ref| ref.__getobj__ rescue nil }
        }
        # A DISPOSED driver is not live: its runtime context is gone, so calling into it raises
        # (`undefined method 'call' for nil` out of `run_loop_step`). `dispose` deregisters, but the
        # predicate is the belt — a WeakRef stays in the list until GC actually collects.
        drivers.each {|d| yield d if d.owner_thread == thread && !d.disposed? }
      end

      # `viewport: [w, h]` and `user_agent:` (typically supplied via
      # `Capybara.register_driver`) force the JS-side
      # `innerWidth`/`innerHeight` and `navigator.userAgent` (plus
      # `HTTP_USER_AGENT` on Rack requests) before the first navigate,
      # so `matchMedia` / mobile-breakpoint branches and server-side
      # UA-based mobile detection both resolve before any document
      # loads. The Browser tracks both as "defaults" so `reset!`
      # (per-test teardown) restores them between specs. `touch: true` is a
      # session whose pointer is a touchscreen, as Playwright's `hasTouch`
      # emulates a phone's: `(pointer: coarse)` and nothing hovers, in the
      # page's CSS and its `matchMedia` alike.
      def initialize(app, viewport: nil, user_agent: nil, touch: false)
        # `Capybara.disable_animation` is delivered to the real drivers by a SERVER
        # middleware (session.rb adds AnimationDisabler to the Puma stack), which
        # injects `animation-duration: 0s !important` CSS into every HTML response.
        # This driver calls the Rack app in-process and never builds that server, so
        # the same wrap happens here — an app suite that turns animations off
        # (Discourse's rails_helper) must see the same 0s durations a real browser
        # run sees, or every `await`-on-animation close path (FloatKit's menu) parks
        # on a full-length animation-fallback timer no user action waits for.
        @app             = Capybara.disable_animation ? Capybara::Server::AnimationDisabler.new(app) : app
        # Cookies + localStorage are origin-shared across windows
        # (real browser semantics), so we own the jars at the Driver
        # level and inject them into every per-window Browser. Each
        # Browser still has its own sessionStorage + DOM + JS VM.
        # Cookies: the session's cookie store in the engine (cookie_jar.rs), every window's.
        @cookie_jar      = Native.cookie_jar_new
        # HTTP authentication: the session's entries in the engine (http_auth.rs), every window's.
        @auth_cache      = Native.http_auth_new
        # localStorage: the session's storage shed in the engine (storage_areas.rs), an area per origin, every window's.
        @local_storage   = Native.storage_partition_new
        # …and IndexedDB, Cache Storage and the system clipboard, the session's partition of the engine's registries,
        # which a service worker and every same-origin window share — and every window and frame and the next visit the
        # clipboard (idb_databases.rs, cache_storage.rs, system_clipboard.rs).
        @session_partition = Native.session_partition_new
        # Capture the universal-server flag ONCE, at session construction — the WPT
        # runner sets CSIM_LOCAL_ALL_HOSTS only while building the session, then
        # restores it. Every window (incl. aux windows opened later) inherits this so
        # cross-origin iframes eager-build consistently across the whole session.
        @all_hosts_local = ENV['CSIM_LOCAL_ALL_HOSTS'] == '1'
        # …and the session's device, every window's: its viewport, its user agent and whether its pointer is a
        # touchscreen.
        @viewport        = viewport
        @user_agent      = user_agent
        @touch           = touch
        # …and how many windows it has made: each mints its contexts' ids in a space of its own (Browser#client_space).
        @client_spaces   = 0
        @browser         = build_window_browser
        @browser.window_handle = PRIMARY_HANDLE
        # The session's other windows, `{handle:, window:, opener:}` each: a window a Browser of its own hosts — its own
        # isolate, a browsing context group of its own or a pop-up of another's — or one `window.open` made in a Browser's
        # isolate (RealmWindow), addressed in its host.
        @aux_windows     = []
        # Browsers whose WINDOW closed while they still host an active service-worker
        # registration. A registration is profile-wide state independent of the document
        # that created it (a page registers, closes, and the SW keeps controlling
        # navigations elsewhere), so the Browser is parked — keeping its SW worker
        # thread + scope registry alive for sw_navigation_fetch — instead of disposed.
        # Reclaimed by reset_windows!.
        @sw_parked       = []
        @active_handle   = nil
        @next_window_seq = 0
        @owner_thread    = Thread.current
        @@live_lock.synchronize { @@live << WeakRef.new(self) }
      end

      private def build_window_browser
        Browser.new(@app,
                    driver:          self,
                    cookie_jar:      @cookie_jar,
                    auth_cache:      @auth_cache,
                    local_storage:   @local_storage,
                    session_partition: @session_partition,
                    all_hosts_local: @all_hosts_local,
                    client_space:    (@client_spaces += 1) == 1 ? '' : "w#{@client_spaces}-").tap do |b|
          b.touch_input        = @touch
          b.default_viewport   = @viewport   if @viewport
          b.default_user_agent = @user_agent if @user_agent
        end
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

      # The ACTIVE window's page, painted for the trace's final state (`TracePersistence`) —
      # `current_browser`, like every other user-facing read here, not the primary `browser`: a
      # test that ended inside `switch_to_window` would otherwise be handed a picture of the
      # window it was not looking at. (…the primary's where the active window closed: the test ended on none)
      def trace_screenshot = (active_browser || @browser).trace_screenshot

      def tracing?      = !current_trace.nil?
      def current_trace = browser.trace || browser.pending_trace

      attr_reader :browser

      # Active window's Browser. Primary by default; switches when the
      # test calls `switch_to_window(aux_handle)`. Every DOM / URL /
      # JS-touching driver method routes through here so per-window
      # state (DOM, sessionStorage, history) stays window-scoped.
      # The active window closed — by Capybara's `Window#close`, or its own script's `close()` — every command is
      # `no_such_window_error` until another window is switched to (Capybara::Window#close), as WebDriver's "no such
      # window": none falls back to the primary, nor reaches the unloaded document.
      def current_browser
        active_browser or raise Capybara::WindowError, "Window #{@active_handle} is closed; switch to another window"
      end
      # …nil for one closed: its close run (Browser#discard_due?), or discarded.
      private def active_browser
        return @browser unless @active_handle

        window = @aux_windows.find {|w| w[:handle] == @active_handle }&.fetch(:window) or return
        settle_close(window)
        window unless window.discard_due?
      end
      # A window `window.open` made in a Browser's isolate whose script asked to close it, its close a task of its host's
      # event loop due now: run, as the driver is between calls (Browser#run_due_tasks) — as another isolate's close is
      # taken as the action that asked for it ends (Browser#take_window_tasks).
      private def settle_close(window)
        window.host.run_due_tasks if window.is_a?(RealmWindow) && window.closing? && !window.discard_due?
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

      # Run one real-cadence event-loop frame and return the loop's observable
      # state. Drives "advance the page one frame" without the full poll tick
      # `evaluate_script` would incur per read; the wpt_runner uses it to drain a
      # page to completion at browser cadence.
      #
      # EVERY live window steps, not just the active one — the primary too while a
      # pop-up is the active window: an auxiliary window is a separate VM, but the
      # cross-context orchestration the dispatcher framework builds on (a popup running
      # an executor that polls a shared queue while the opener waits) needs those
      # background windows to make progress autonomously. The active window's state
      # leads; each other window folds its progress / raf / async / nearest-timer in so
      # the caller keeps pumping while any window works. The windows a `close()` closed
      # are discarded after (`reap_closed_windows`), none of theirs on the stack.
      def run_event_loop_frame(frame_ms)
        reap_closed_windows
        # (…the primary's where the active window closed: no command of the test's, which alone are refused then)
        current = host_of(active_browser || @browser)
        state = current.run_event_loop_frame(frame_ms)
        # Iterate a SNAPSHOT: a window's drain can open or close windows mid-loop (a
        # popup spawning another). Re-check each window is still open before stepping
        # it, and isolate a per-window failure so one dead/half-torn-down VM can't abort
        # the whole frame pump.
        window_browsers.each do |b|
          next if b.equal?(current) || !window_browsers.include?(b)

          begin
            state = merge_frame_state(state, b.run_event_loop_frame(frame_ms))
          rescue StandardError
            next
          end
        end
        reap_closed_windows
        state
      end

      # Worker cross-thread work in flight in ANY window — the same aggregate scope
      # as run_event_loop_frame's merged `async` (which folds every window in), so a
      # caller distinguishing "waiting on a worker thread" from other async channels
      # (the wpt_runner's clock-hold) sees a popup-hosted worker/SW round trip too,
      # not just the active window's.
      def worker_drive_pending? = window_browsers.any?(&:worker_drive_pending?)

      # Fold an aux window's frame state into the running aggregate: any window that
      # progressed / has a queued rAF / has an async channel in flight keeps the
      # whole loop live, and `next_timer` becomes the nearest pending timer across
      # all windows (-1 only when every window is timer-idle).
      private def merge_frame_state(a, b)
        an = a['next_timer'].to_f
        bn = b['next_timer'].to_f
        merged =
          if an.negative? then bn
          elsif bn.negative? then an
          else [an, bn].min
          end
        {
          'raf'        => a['raf'] || b['raf'],
          'async'      => a['async'] || b['async'],
          'next_timer' => merged,
          'progressed' => a['progressed'] || b['progressed']
        }
      end

      # Clock-free read of a JS expression in the active browsing context (no
      # virtual-time advance, unlike evaluate_script) — for polling page state
      # between event-loop frames without perturbing the clock.
      def peek_script(expr) = current_browser.peek_script(expr)

      def visit(path)          = current_browser.visit(path)
      def refresh              = current_browser.refresh
      def reset!
        reset_windows!
        browser.reset!
      end

      # Start the next fetches from a cold HTTP cache. `reset!` keeps what a persistent
      # browser profile would — fresh `Cache-Control: immutable` responses, plus the
      # still-fresh script / stylesheet sources and @font-face files — so a test whose
      # app serves new bytes at a cacheable URL it already served (a stylesheet digested
      # from a DB row that a rolled-back example reuses) asks for the cold cache a fresh
      # Playwright / Cuprite context starts with. Process-wide: every session shares the
      # one cache (`Capybara::Simulated.clear_http_cache` is the same call for a hook
      # that runs before any session exists).
      def clear_http_cache = Browser.clear_http_cache

      # Join every window's background app-request threads (async <img> loads,
      # keepalive fetches) without resetting anything else. The test harness calls
      # this ahead of the app's own after-hooks: cleanup that bypasses
      # ActiveRecord's per-connection lock (Discourse's mini_sql `DB.exec`) must
      # not interleave with a still-running background request on the same raw
      # socket — `reset!`'s drain alone runs after those hooks.
      def drain_background_requests
        window_browsers.each {|b| b.drain_app_request_threads rescue nil }
      end

      # Dispose every auxiliary window and return focus to the primary — a fresh
      # browsing context has no sibling windows. Disposing each aux Browser tears
      # down its worker / SSE / websocket threads and its V8 isolate eagerly; left
      # alone they are reclaimed by nothing until the at_exit hook (the engine
      # roots every attached host fn — see V8Runtime's `@@live`), which on a
      # long-lived multi-file session (the WPT runner) means a slow — sometimes
      # minutes-long — process exit. Split
      # out of `reset!` so a caller can drop windows WITHOUT resetting the primary's
      # page state (the WPT runner rebuilds the primary itself, per file, via visit).
      # (…a window `window.open` made in a Browser's isolate, which outlives its page's navigations, let go of in its host)
      def reset_windows!
        @aux_windows.each do |w|
          window = w[:window]
          window.is_a?(Browser) ? (window.dispose rescue nil) : window.discard!
        end
        @aux_windows.clear
        @sw_parked.each {|b| b.dispose rescue nil }
        @sw_parked.clear
        @active_handle = nil
      end

      # Full teardown of the whole driver: aux windows AND the primary browser's
      # V8 isolate. `reset_windows!` deliberately keeps the primary alive (the
      # per-test reset path rebuilds only its page); this is for permanently
      # DROPPING a session. A caller that nils its session without this leaks the
      # primary isolate — with its heap, canvas pixel buffers, and worker threads —
      # until at_exit, no GC being able to reach it (V8Runtime's `@@live` explains
      # why: the engine roots the attached host fns). The WPT runner recycles
      # the cross-origin session per `.sub.`/`.https.` file, so that leak is ~one
      # isolate per cross-origin file (hundreds over the suite); disposing here
      # incrementally is what reset_windows! already does for aux windows.
      def dispose
        return if @disposed
        @disposed = true
        # Drop out of the live registry FIRST: everything below tears down the runtime this driver
        # would be asked to step if `each_live_on_thread` still yielded it.
        @@live_lock.synchronize {
          @@live.select!(&:weakref_alive?)
          @@live.reject! {|ref| (ref.__getobj__ rescue nil).equal?(self) }
        }
        reset_windows!
        @browser.dispose rescue nil
        # …and the session's IndexedDB databases, caches and localStorage, which outlive every window but not the session.
        Native.session_partition_clear(@session_partition)
        Native.storage_clear(@local_storage)
      end

      # Whether the session has a window besides the primary (Browser#background_windows) — the common session's none.
      # (…a Browser of its own: a window `window.open` made in this one's isolate is stepped with it)
      def several_windows? = @aux_windows.any? {|w| w[:window].is_a?(Browser) }

      # The session's windows' browsers — the primary's, then each auxiliary window's own — the isolates whose event loops
      # step every window (a window `window.open` made in one its host's): none whose close ran, which waits only to be
      # discarded (`reap_closed_windows`).
      def window_browsers = [@browser] + @aux_windows.filter_map {|w| w[:window] if w[:window].is_a?(Browser) && !w[:window].discard_due? }
      # …the one whose event loop window `window` is stepped by: its own, or its host's.
      private def host_of(window) = window.is_a?(RealmWindow) ? window.host : window

      # Has this driver been permanently dropped? (A `reset!` between examples does NOT set this —
      # that rebuilds the page on a live runtime.)
      def disposed? = @disposed == true
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

      # Capybara `within_frame` / `switch_to_frame`. `frame` is the iframe
      # `Capybara::Node::Element` (its `.native` is our driver Node), or the
      # `:parent` / `:top` symbols. The block's finds + actions then route into
      # the frame's own V8 realm via the Browser's `@current_realm_id`.
      def switch_to_frame(frame)
        target = frame.is_a?(Symbol) ? frame : frame.native.handle_id
        current_browser.switch_to_frame(target)
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
        reap_closed_windows
        [PRIMARY_HANDLE] + @aux_windows.map {|w| w[:handle] }
      end

      # All window entries (primary + aux) as `{handle:, window:, opener:}`.
      # (…none whose close ran: no window of the session reaches it, its opener's `opener` of it none — Browser#close_steps)
      private def window_entries
        [{handle: PRIMARY_HANDLE, window: @browser, opener: nil}] + @aux_windows.reject {|w| w[:window].discard_due? }
      end
      # …the one whose target name is `name` (its `window.name`, as it stands: Browser#window_name) in `from`'s browsing
      # context group, that `from` is familiar with — HTML "find a navigable by target name" searches the group's set,
      # skipping those: a `noopener` window's name finds none of its opener's, a cross-origin pop-up's none of the page's
      # (Chrome and Firefox open a new window) — none for '' or none `from`. None that is closing: its `close()` takes it
      # out of every lookup by name at once, its discard a task later (WPT close-method.window.js).
      # Only the session's other Browsers are searched: never `from`'s own page, nor a window `window.open` made in a
      # Browser's isolate (RealmWindow). For `from`'s own isolate, its engine has already chosen (navigables.rs
      # `find_navigable`, which judges the frame that named the window and its sandbox). When it asks here, it chose a new
      # window: a sandboxed frame, or a frame not familiar with the window of that name, must not reach it. No other
      # isolate's WindowProxy reaches a RealmWindow (`isolate_window`) until R13 S6 brings every pop-up of a group into its
      # opener's isolate, so another isolate that names one opens a window of its own meanwhile.
      # (…"familiar with" between top-level windows, session_history.rs `familiar`: none once its page disowned it, Chrome
      # and Firefox measured — a window that set `opener = null` is found by no name its opener's cross-origin page gives.
      # `from`'s page's document is judged, also when a frame of `from` names another isolate's window, and the frame's
      # sandbox is not asked — a gap: a frame not familiar with that window, or sandboxed against navigating it, reaches it)
      private def named_window(name, from)
        return if name.empty? || from.nil?

        window_entries.find {|w|
          target = w[:window]
          target.is_a?(Browser) && !target.equal?(from) && target.window_name == name && !target.closing? &&
            target.browsing_context_group == from.browsing_context_group && from.traversable.familiar_with?(target.traversable)
        }
      end

      # The Browser backing a handle, or nil if the window is closed/unknown.
      # (…a window `window.open` made in a Browser's isolate its RealmWindow)
      def window_browser(handle)
        window_entries.find {|w| w[:handle] == handle }&.fetch(:window)
      end

      # …the Browser of a window of its own isolate, which the remote-ref RPC and another isolate's WindowProxy address —
      # none for a window `window.open` made in a Browser's isolate, which no other isolate's proxy reaches (R13 S6).
      private def isolate_window(handle) = (window = window_browser(handle)).is_a?(Browser) ? window : nil

      # Same, but for the operations that ADDRESS a window rather than probe for one: a closed or
      # unknown handle is Capybara's `WindowError`, never a silent fall back to the current window.
      def window_browser!(handle)
        window_browser(handle) or raise Capybara::WindowError, "Unknown window handle: #{handle}"
      end

      # Open (or, by `name`, reuse) an auxiliary window. `target="_blank"`
      # clicks and `window.open` both land here. A non-empty `name` that
      # matches an existing window navigates that window instead of opening a
      # new one (HTML window-name targeting); `opener_handle` records the
      # opener so the new window's `window.opener` resolves back to it.
      # (…`activation_realm` the realm of `source`'s whose window chose the new one, whose user activation a new window
      # consumes — not one a name found)
      # (…`by_script` whether web content made it — a script's `window.open`, a link's or a form's target — which a script
      # may close, not the driver's `open_new_window`: HTML "is created by web content", its traversable's)
      def open_aux_window(url = nil, name: nil, opener_handle: nil, source: nil, blob_snapshot: nil, post: nil, opener: false, referrer: nil, referrer_policy: nil, creator: nil, activation_realm: nil,
                          user_activated: nil, by_script: true)
        name = name.to_s
        # (…a document's to a `data:` URL, which a top-level browsing context refuses one's navigation to — a new window
        # opened at about:blank, a named one left as it is: Browser#top_level_data_refused?)
        refused = source&.top_level_data_refused?(url)
        # (…the policy the opening hyperlink sets, else its document's)
        referrer_policy = source&.main_document_referrer_policy if referrer_policy.to_s.empty?
        # A blob: URL opened from a different storage partition is forced noopener
        # (cross-partition-navigation), overriding an explicit rel=opener — the new
        # top-level window is the blob's own partition (so the blob still loads), but
        # the opener relationship is severed.
        opener = false if opener && url.to_s.start_with?('blob:') && source && cross_partition_blob?(url, source)
        # A window opened with its opener (`opener`: a hyperlink's or a form's whose noopener HTML "get an element's
        # noopener" leaves unset — `rel=opener`, a named target) — resolve the opener handle from the source.
        opener_handle ||= handle_for(source) if opener && source
        if (existing = named_window(name, source))
          return existing[:handle] if refused

          # (…its navigation carrying whether the opening document's window has transient activation, unconsumed: no new
          # one is made)
          activated = user_activated.nil? ? source && activation_realm && source.source_activated?(activation_realm) : user_activated
          plan = {
            source:          source,
            initiator_realm: activation_realm,
            referrer:        referrer,
            referrer_policy: referrer_policy,
            user_activated:  activated
          }
          if post
            post_window(existing[:window], url, post, **plan)
          else
            navigate_window(existing[:window], url, **plan)
          end
          return existing[:handle]
        end
        # (…the window's own navigation carrying whether its opener had it: the source snapshot's — its plan's, where a
        # hyperlink or a form planned it, else taken as it opens)
        url = 'about:blank' if refused
        had = source && activation_realm ? source.consume_user_activation(activation_realm) : source.nil?
        activated = user_activated.nil? ? had : user_activated
        @next_window_seq += 1
        handle = "csim-window-#{@next_window_seq}"
        aux = build_window_browser
        aux.window_handle = handle
        # Registered BEFORE its documents boot: their scripts read
        # `window.opener`, which resolves through this entry — so the entry
        # (with its opener) must exist before they run.
        aux.window_name = name
        # (…its opener browsing context the one opening it, which another window's familiarity with it goes through)
        # (…a window `window.open` made in a Browser's isolate its host's, whose traversable the engine knows: a gap until
        # R13 S6 brings the pop-up into that isolate)
        if (opener_window = window_browser(opener_handle))
          aux.traversable.opener = host_of(opener_window).traversable
        end
        aux.traversable.by_web_content = by_script
        @aux_windows << {handle: handle, window: aux, opener: opener_handle}
        # (…another window of the session now, which may resolve the URLs the others made before it: their bytes entered in
        # the registry, for its workers' threads to read — Browser#partition_blob)
        window_browsers.each {|b| b.fill_blob_markers unless b.equal?(aux) }
        # (…in its opener's browsing context group, where it has one: its about:blank, cross-origin isolated as it is)
        if opener_handle && source
          aux.inherit_cross_origin_isolation(source)
          aux.inherit_browsing_context_group(source)
          # (…and its session storage a copy of its opener's, as it opens: HTML "copy the session storage" — Chrome measured)
          Native.storage_copy(source.session_storage_shed(activation_realm.to_i), aux.session_storage_shed)
        end
        # (…and its initial about:blank document its creator's origin and base URL — the document that called
        # `window.open`: a window it opens at about:blank stays that document, its origin no new opaque one)
        aux.inherit_creator(**creator) if creator && opener_handle
        # Its initial about:blank, made with it (HTML "create a new auxiliary browsing context": what `open()` hands back is
        # a window at it, which its opener's script reads as the call returns), firing no load — and the navigation it was
        # opened for, if any, planned: a task of the window's own that its event loop takes once this one's script is done
        # (Browser#take_window_tasks), its document parsed, its scripts run and its load fired there, as any of its
        # navigations' are (HTML "window open steps": "navigate" the new navigable) — a `<form target=_blank method=post>`'s
        # a POST carrying its form's document's origin, a blob: URL's the blob of the click-time snapshot (a link's whose
        # URL its page may revoke first) or of the source's store, the source's document its initiator either way. (…an
        # about:blank one's none: the initial document at its URL — HTML's "URL and history update steps" in its place —
        # the document it was opened for, whose Window the next does not keep: `opened_at_initial`)
        about_blank = url.to_s.match?(Browser::ABOUT_BLANK)
        aux.open_initial_document(about_blank ? url.to_s : 'about:blank')
        if about_blank || url.to_s.empty?
          aux.traversable.opened_at_initial
        else
          plan = {
            source:          source,
            initiator_realm: activation_realm,
            referrer:        referrer,
            referrer_policy: referrer_policy,
            user_activated:  activated
          }
          if post
            post_window(aux, url, post, **plan)
          else
            blob = {bytes: blob_snapshot['bytes'], type: blob_snapshot['type'].to_s} if blob_snapshot.is_a?(Hash) && blob_snapshot['bytes']
            navigate_window(aux, url, blob: blob, **plan)
          end
        end
        handle
      end

      # A window `window.open` made in `host`'s isolate, its first document's realm `realm` — the key it is known by after
      # (RealmWindow) — a window of the session from now on, with a handle of its own.
      # (…its opener the window of `opener_realm`'s document: one `window.open` made in the same isolate, or the host's page)
      private def add_realm_window(host, realm, opener_realm)
        window = RealmWindow.new(host, realm)
        window.window_handle = "csim-window-#{@next_window_seq += 1}"
        @aux_windows << {handle: window.window_handle, window: window, opener: handle_of_realm(host, opener_realm)}
        window
      end
      # The handle of the window whose document is realm `realm` of `host`'s isolate: a window `window.open` made there,
      # else the host's own (its page, or a frame of it).
      private def handle_of_realm(host, realm)
        window = @aux_windows.find {|w| w[:window].is_a?(RealmWindow) && w[:window].host.equal?(host) && w[:window].realm == realm }
        window ? window[:handle] : handle_for(host)
      end

      # ── JS-facing window routing (called via Browser host fns) ──────
      # Each window is a separate Browser/VM, so a cross-window reference is a
      # proxy that forwards here; the Driver routes to the target Browser.

      # `window.open(url, name)` from the `opener` window's JS. Resolves the URL
      # against the opener's document and records the opener relationship.
      # (…`noopener` one with none — `window.open` returning null, its about:blank document a new opaque origin, not the
      # opener's — and `referrer` / `referrer_policy` its navigation's, the calling document's)
      def open_window_from_js(opener_browser, url, name, opener_realm_id = 0, about_base = nil, about_origin = nil, noopener: false, referrer: nil, referrer_policy: nil)
        resolved = url.to_s.empty? ? nil : opener_browser.resolve_document_url(url)
        # (…none to a `data:` URL, which a top-level browsing context refuses a document's navigation to: the window
        # opened at about:blank, as at an empty URL — a named one left as it is)
        resolved = nil if opener_browser.top_level_data_refused?(resolved)
        # Opening a blob: URL whose storage partition differs from the opener's
        # top-level site is forced NOOPENER (cross-partition-navigation): the new
        # auxiliary window is its own top-level context in the blob's partition, so the
        # blob still loads — but there is no opener relationship and `window.open`
        # returns null. Same-partition keeps the normal opener.
        noopener ||= resolved.to_s.start_with?('blob:') && cross_partition_blob?(resolved, opener_browser)
        if noopener
          # (…no opener_handle ⇒ window.opener null)
          # (…an empty URL about:blank, as the window open steps make it: the opener path's window realm is that already)
          open_aux_window(resolved || 'about:blank', name: name, source: opener_browser, activation_realm: opener_realm_id, referrer: referrer, referrer_policy: referrer_policy)
          return nil
        end
        # A name an existing window has chooses that window — navigated where a URL was given — before an empty URL
        # makes a new about:blank realm (HTML "the rules for choosing a navigable": `open('', 'nm')` is `nm`'s window).
        if (existing = named_window(name.to_s, opener_browser))
          navigate_window(
            existing[:window],
            resolved,
            source:          opener_browser,
            initiator_realm: opener_realm_id,
            referrer:        referrer,
            referrer_policy: referrer_policy,
            user_activated:  opener_browser.source_activated?(opener_realm_id)
          )
          return existing[:handle]
        end
        # A window opened at about:blank → a realm in the opener's isolate (shared heap); the
        # returned realm-id context becomes a native WindowProxy on the JS side, so
        # cross-window scripting/adoption need no cross-isolate RPC. The opener's realm
        # id wires the popup's window.opener. One opened at a URL takes the separate-VM aux path still (R13 S6: its
        # move into the opener's isolate is the next stage).
        if resolved.nil? && (rid = opener_browser.open_window_realm(name: name, opener_realm_id: opener_realm_id, about_base: about_base, creator_url: referrer))
          add_realm_window(opener_browser, rid, opener_realm_id)
          return rid
        end
        open_aux_window(
          resolved,
          name:             name,
          opener_handle:    handle_of_realm(opener_browser, opener_realm_id),
          source:           opener_browser,
          activation_realm: opener_realm_id,
          referrer:         referrer,
          referrer_policy:  referrer_policy,
          creator:          {origin: about_origin, base: about_base, url: referrer}
        )
      end


      # The Browser whose window's registry is number `window` — the window a blob URL's
      # maker is in — among the open, the primary and the parked ones.
      private def browser_of_blob_window(window)
        (window_browsers + @sw_parked).find {|b| b.blob_window == window }
      end
      # Whether a window of this session other than `browser`'s is open (Browser#blob_shared?).
      def other_windows?(browser)
        window_browsers.any? {|b| !b.equal?(browser) }
      end

      # Is this blob: URL in a different storage partition than `accessor`'s top-level
      # site? Unknown blobs (no entry) are treated as same-partition (no extra gating
      # beyond the existing same-origin behaviour).
      # (…the storage-partition site the URL was created in — its creator's top-level site, in a window of the
      # accessor's session: blob_registry.rs `partition`, its fragment aside, as a fetch of it resolves)
      def cross_partition_blob?(url, accessor)
        site = Native.blob_registry_partition(accessor.blob_window, url.to_s)&.last
        !site.nil? && site != accessor.blob_partition_site
      end

      # Resolve a blob: URL's bytes from whichever Browser created it (the bytes live
      # in the creator's isolate, not necessarily the navigator's). Used to load a blob
      # document into a TOP-LEVEL window (window.open / a window navigation): that new
      # context is the blob's own partition, so no partition gate applies here — the
      # cross-partition rule for windows is the noopener severing above. (A nested frame
      # resolves another window's URL only in its own partition: Browser#partition_blob.)
      # Falls back to the accessor's own store for an unpartitioned URL (worker / legacy
      # path).
      def blob_bytes_for(url, accessor)
        maker = Native.blob_registry_partition(accessor.blob_window, url.to_s)&.first
        creator = (maker && browser_of_blob_window(maker)) || accessor
        creator.respond_to?(:read_blob_for_window) ? creator.read_blob_for_window(url) : nil
      end

      # A same-partition `URL.revokeObjectURL(url)` from `source` (Browser#blob_unregister, which the registry let
      # through: blob_registry.rs `revoke_partitioned`) of a URL another window's context made: the blob dropped in
      # THAT window's isolate too, so every window stops resolving it.
      def drop_blob_in_window(window, url, source)
        creator = browser_of_blob_window(window)
        creator.drop_local_blob(url.to_s) if creator && !creator.equal?(source)
      end

      # Load a blob: document into top-level window `target`. The bytes live in
      # whichever Browser created the blob, not the target's — `blob_bytes_for` fetches
      # them cross-isolate. Returns false when the blob is unavailable (revoked), so
      # the caller falls back. A click-time `snapshot` is the navigating context's own
      # blob captured before a deferred nav could revoke it.
      private def load_blob_into_window(target, url, source, snapshot: nil)
        data = if snapshot.is_a?(Hash) && snapshot['bytes']
          {bytes: snapshot['bytes'], type: snapshot['type'].to_s}
        else
          blob_bytes_for(url, source)
        end
        return false unless data
        target.boot_blob_document(url, data[:bytes], data[:type])
        true
      rescue StandardError
        false
      end

      # `BroadcastChannel.postMessage` — deliver to every OTHER window's channels
      # with the same name (same-window delivery is handled in-VM by the sender).
      def broadcast_channel(source_browser, name, data, origin = nil)
        # An opaque origin is unique to its own agent cluster; its key is a token ('opaque:…') minted
        # per-realm and therefore only unique WITHIN one isolate — two unrelated opaque contexts in
        # DIFFERENT windows could mint the same token. A BroadcastChannel never bridges two distinct
        # opaque origins, and no opaque origin spans separate top-level windows here, so a cross-
        # WINDOW post from an opaque origin reaches no one: drop it rather than risk a cross-isolate
        # token collision. (Same-isolate opaque peers are reached in-VM / via enqueue_broadcast; an
        # inherited-origin blob worker via its own inbox — neither goes through this cross-window path.)
        return if origin.to_s.start_with?('opaque:')
        window_browsers.each do |b|
          b.enqueue_broadcast(name, data, nil, origin) unless b.equal?(source_browser)
        end
      end

      # A localStorage change fans out to every OTHER window (localStorage spans browsing
      # contexts — the Driver's one shed, an area per storage key); a nil source realm reaches
      # each target's every realm, whose documents of another key let it go (storage.js).
      # sessionStorage is per-context and never reaches this path.
      def storage_broadcast(source_browser, kind, key, old, new, url, area)
        window_browsers.each do |b|
          b.enqueue_storage_event(kind, key, old, new, url, area, nil) unless b.equal?(source_browser)
        end
      end

      # raw_: an identity read — this runs inside host-fn callbacks (a popup's boot
      # script reading opener.location), where the ticking current_url must not re-enter.
      def window_location(handle)        = (isolate_window(handle)&.raw_current_url).to_s
      # The number of the top-level traversable the window of `handle` is, nil for one gone.
      def window_traversable(handle)     = isolate_window(handle)&.traversable&.id
      # Cross-window remote-ref RPC: route a node/object proxy op to the window
      # that owns the ref (handle), executing in that window's VM.
      def window_ref_get(handle, id, prop)         = (b = isolate_window(handle)) ? b.remote_ref_get(id, prop) : nil
      def window_ref_set(handle, id, prop, value)  = ((b = isolate_window(handle)) && b.remote_ref_set(id, prop, value))
      def window_ref_has(handle, id, prop)         = (b = isolate_window(handle)) ? b.remote_ref_has(id, prop) : false
      def window_ref_delete(handle, id, prop)      = (b = isolate_window(handle)) ? b.remote_ref_delete(id, prop) : false
      # (…a function it returns a callback handle for the caller's realm `receiver`)
      def window_ref_call(handle, id, method, args, receiver)
        nesting_window_calls { (b = isolate_window(handle)) ? b.remote_ref_call(id, method, args, receiver) : nil }
      end
      # …and a callback the window of `handle` handed the one of `caller` (a function of its realm `realm`, by its id),
      # called back in that window — synchronously, as the caller's task runs, as a browser's one event loop would call
      # it: `w.onload = f` heard as the window's load dispatches — let go of once the caller holds it no more, and what it
      # threw out of a dispatch there reported in its own realm.
      def window_ref_apply(handle, realm, id, this, args, caller, receiver)
        nesting_window_calls { (b = isolate_window(handle)) ? b.remote_ref_apply(realm, id, this, args, caller, receiver) : UNDEFINED }
      end
      def window_ref_release(handle, realm, id)  = isolate_window(handle)&.remote_ref_release(realm, id)
      def window_ref_report(handle, realm, thrown) = isolate_window(handle)&.remote_ref_report(realm, thrown)
      def window_ref_sweep(handle)                 = isolate_window(handle)&.collect_released
      # The windows' calls into one another, each a host call within the last on the one native stack: nested past
      # `WINDOW_CALL_DEPTH_MAX`, the innermost a RangeError its caller throws, as a browser's one stack overflows — calls
      # that recurse from window to window without end (host-queries.js `__remoteThrow`'s marker). Each nests ~11 KB of the
      # main thread's 8 MB stack (Ruby's and V8's frames): Ruby's own "stack level too deep" measured at ~720 nested calls (a
      # ping-pong 360 round trips deep), so 500, a margin below it — 250 round trips, each two calls.
      WINDOW_CALL_DEPTH_MAX = 500
      STACK_OVERFLOW = {'__csimThrow' => {'name' => 'RangeError', 'message' => 'Maximum call stack size exceeded', 'stack' => ''}}.freeze
      # …and what a callback of a window gone, or of a document gone, returns: nothing, as a function that returns none.
      UNDEFINED = {'__csimUndefined' => true}.freeze
      private def nesting_window_calls
        return STACK_OVERFLOW if @window_call_depth.to_i >= WINDOW_CALL_DEPTH_MAX

        @window_call_depth = @window_call_depth.to_i + 1
        begin
          yield
        ensure
          @window_call_depth -= 1
        end
      end
      # A cross-window Location-object navigation (`w.location = url`, `w.location.replace(url)`, …) to `url`, which the
      # caller parsed — per HTML relative to the ENTRY settings object, the document of the script navigating, NOT the
      # target window's (platform-globals.js `csimWindowProxy`) — by the window `source`, its initiator, sending `referrer`
      # by `referrer_policy`, with history handling "replace" where `replace` — its document the one of `source`'s realm
      # `realm` whose script set it.
      def window_set_location(source, handle, url, realm: 0, referrer: nil, referrer_policy: nil, user_activated: false, replace: false)
        b = isolate_window(handle) or return
        navigate_window(
          b,
          url,
          source:          source,
          initiator_realm: realm,
          referrer:        referrer,
          referrer_policy: referrer_policy,
          user_activated:  user_activated,
          replace:         replace
        )
      end
      # The handle of the window that opened `browser`'s — none once that one is discarded (HTML's `opener` getter: its
      # opener browsing context's WindowProxy, none for a context gone; WPT opener-closed.html).
      # (…a window `window.open` made in a Browser's isolate, which no other isolate reaches, its host's page standing in:
      # a gap until R13 S6)
      def opener_handle_of(browser)
        handle = handle_for(browser)
        opener = window_entries.find {|w| w[:handle] == handle }&.fetch(:opener)
        window = window_browser(opener)
        window.is_a?(RealmWindow) ? handle_for(window.host) : (opener if window)
      end
      private def handle_for(browser) = browser.window_handle

      # Navigate an existing window, by another window's script (`source`'s): HTML "navigate", whose source snapshot —
      # the Referer, the initiator (the document of `source`'s realm `initiator_realm` whose script asked — a frame's, not
      # its page's — whose site Sec-Fetch-Site and the SameSite cookie gate measure from, of none where its origin is
      # opaque, a sandboxed one's: Browser#navigation_initiator), the activation, the history handling — is taken here, as
      # the script asks, and whose navigation the window begins as a task of its own event loop (Browser#take_window_tasks):
      # never while the script that asked is on the stack, nor one of the window's own (its context rebuilt under it).
      # (…`user_activated` whether the navigating document's window had transient activation as it began; `replace` its
      # history handling "replace")
      # A blob: URL's blob is resolved here too, in the source's blob URL store (`blob_bytes_for`), as HTML resolves a URL's
      # blob URL entry as it is parsed: one the source revokes after still loads; none, a revoked one's, is a network error.
      # (…`blob` the one a snapshot taken before already holds: a link's, as it was clicked)
      private def navigate_window(browser, url, source:, initiator_realm: 0, referrer: nil, referrer_policy: nil, user_activated: false, replace: false, blob: nil)
        return if url.nil? || url.to_s.empty? || Browser::DATA_URL.match?(url.to_s)
        if browser.is_a?(RealmWindow)
          return navigate_realm_window(browser, url, source, initiator_realm, referrer: referrer, referrer_policy: referrer_policy, user_activated: user_activated, replace: replace)
        end

        blob ||= blob_bytes_for(url, source) if url.to_s.start_with?('blob:')
        initiator = source.navigation_initiator(initiator_realm.to_i)
        browser.traversable.plan_navigation(
          url.to_s,
          replace,
          user_activated == true,
          referrer,
          referrer_policy,
          initiator,
          blob&.fetch(:bytes),
          blob&.fetch(:type)
        )
      end

      # …one `window.open` made in a Browser's isolate, by another isolate's document: navigated in its host as its own
      # location would be — the Referer and policy the caller's — its request's initiator the caller's document as its
      # Browser describes it (Browser#navigation_initiator of `source`'s realm `initiator_realm`), which no realm of that
      # isolate is.
      private def navigate_realm_window(window, url, source, initiator_realm, referrer:, referrer_policy:, user_activated:, replace: false, post: nil)
        realm     = window.realm or return
        initiator = source.navigation_initiator(initiator_realm.to_i)
        plan = [url.to_s, replace, nil, referrer, referrer_policy, user_activated == true, nil]
        window.host.navigate_window_realm(realm, 'location', plan, post: post, initiator_document: initiator || {})
      end

      # …a form's submission to it by its name, with a POST resource (HTML "navigate", `documentResource` a POST resource:
      # its encoded body and content type, from the form's document's origin — the initiator's), planned likewise.
      private def post_window(browser, url, post, source:, initiator_realm:, referrer:, referrer_policy:, user_activated:)
        if browser.is_a?(RealmWindow)
          post = [post[:body].to_s, post[:content_type].to_s]
          return navigate_realm_window(browser, url, source, initiator_realm, referrer: referrer, referrer_policy: referrer_policy, user_activated: user_activated, post: post)
        end

        initiator = source.navigation_initiator(initiator_realm.to_i)
        browser.traversable.plan_post(
          url.to_s,
          post[:body].to_s,
          post[:content_type].to_s,
          user_activated == true,
          referrer,
          referrer_policy,
          initiator
        )
      end
      # A blob: document loaded into window `target` from the blob a navigation another window planned of it resolved
      # (`navigate_window`) — false for none.
      def load_blob_document(target, url, bytes, type) = !bytes.nil? && load_blob_into_window(target, url, target, snapshot: {'bytes' => bytes, 'type' => type})

      # Capybara `Session#open_new_window(:tab)` entry point — opens at
      # `about:blank` (so `current_url`/title match a real new tab) and the
      # test then `switch_to_window` + `visit`s the real URL. We don't
      # distinguish `:tab` from `:window` (no window-chrome semantics here).
      def open_new_window(_kind = :tab)
        open_aux_window('about:blank', by_script: false)
      end
      # Every window has its own viewport, so these address the window the
      # handle names — not the active one. `Capybara::Window#resize_to` on a
      # background window must resize THAT window and leave the current one
      # (and Capybara's idea of which window is current) alone.
      def window_size(handle)
        b = window_browser!(handle)
        [b.viewport_width, b.viewport_height]
      end
      # Capybara `Window#close`: the window closed now, the driver's own act — its document unloaded first (HTML "close a
      # browsing context": the teardown events, pagehide+unload, this window and every nested frame, theirs first, fire
      # while the VM still works — a nested iframe's unload keepalive beacon depends on it). The primary is the session's.
      def close_window(h)
        return if h == PRIMARY_HANDLE

        w = @aux_windows.find {|win| win[:handle] == h } or return
        window = w[:window]
        if window.is_a?(RealmWindow)
          window.close!
        elsif !window.discard_due?
          window.fire_document_teardown
        end
        discard_window(w)
      end

      # `close()` of the window of `handle` by the script of `source`'s window (HTML's Window `close()`, whose checks — one
      # script-closable, that the caller is familiar with — are its traversable's: session_history.rs `ask_close`): set
      # closing at once, which its `closed` reports, its close a task of its own event loop (Browser#take_window_tasks)
      # and its discard the driver's after (`reap_closed_windows`). The primary window is the session's, which no script
      # closes (a justified gap where its history has one entry: CLAUDE.md).
      def script_close_window(source, handle)
        isolate_window(handle)&.traversable&.ask_close(source.traversable)
      end

      # Discard the windows whose close ran (Browser#discard_due?) — as the driver is between calls, none of their own
      # on the stack (Browser#window_busy?).
      # (…a window `window.open` made in a Browser's isolate whose script asked to close it closed first: `settle_close`)
      private def reap_closed_windows
        @aux_windows.each {|w| settle_close(w[:window]) }
        @aux_windows.select {|w| w[:window].discard_due? && !w[:window].window_busy? }.each do |w|
          discard_window(w)
        end
      end

      # Discard window `w`'s browser, taking it out of the session's windows: disposed — or, still hosting a live
      # service-worker registration, parked (see @sw_parked): its document-scoped machinery torn down, older parked
      # browsers whose scopes this one re-registered retired (the newest registration for a scope is THE registration,
      # as in a real profile), and the browser kept alive.
      private def discard_window(w)
        @aux_windows.delete(w)
        b = w[:window]
        return b.discard! if b.is_a?(RealmWindow)

        # The windows `window.open` made in its isolate close with it: their documents unloaded, their browsing contexts
        # discarded (Chrome keeps a pop-up open when its opener's tab closes — a gap until R13 S6 gives a pop-up a host
        # of its own to outlive its opener's: a parked Browser steps none of them)
        @aux_windows.select {|o| o[:window].is_a?(RealmWindow) && o[:window].host.equal?(b) }.each do |o|
          @aux_windows.delete(o)
          o[:window].close!
        end
        if b.sw_registrations_active?
          b.park_for_service_workers!
          retire_shadowed_parked(b)
          @sw_parked << b
        else
          b.dispose rescue nil
        end
      end

      # Dispose parked browsers whose live scopes are ALL re-registered by `newcomer` —
      # their registrations are replaced, so keeping the old worker would let a stale
      # SW shadow the new one in sw_navigation_fetch. A partially-overlapping parked
      # browser stays (its non-shadowed scopes are still the live registrations; the
      # newest-first search below picks the newcomer for the shared ones).
      private def retire_shadowed_parked(newcomer)
        fresh = newcomer.sw_live_scopes
        @sw_parked.reject! {|b|
          scopes = b.sw_live_scopes
          next false if scopes.empty? || !(scopes - fresh).empty?
          b.dispose rescue nil
          true
        }
      end

      # Dispose parked browsers whose service workers have all died since parking
      # (the SW unregistered itself / closed) — nothing routes to them anymore, and
      # each pins a whole V8 isolate until reset otherwise.
      private def sweep_dead_parked
        @sw_parked.reject! {|b|
          next false if b.sw_registrations_active?
          b.dispose rescue nil
          true
        }
      end

      # The fetch-event round-trip for a controlled NAVIGATION, resolved across the whole
      # window set: a service-worker registration is profile-wide, so the Browser hosting
      # the controlling SW may be any window's — or a parked one whose window already
      # closed (searched newest-parked first: a re-registered scope's newest worker is
      # the active registration). Returns the owner's respondWith wire hash, or nil
      # (uncontrolled → load from the network).
      def sw_navigation_fetch(url, **kw)
        sweep_dead_parked
        owner = (window_browsers + @sw_parked.reverse).find {|b|
          b.sw_controls_navigation?(url)
        }
        return nil unless owner

        resp = owner.service_worker_navigation_fetch(url, **kw)
        # Nobody pumps a parked browser — drop what the handler queued for its dead
        # clients so the outbox can't grow across a long test.
        owner.drop_dead_letter_worker_messages if @sw_parked.include?(owner)
        resp
      end

      def switch_to_window(h)
        reap_closed_windows
        window_browser!(h)   # unknown / already-closed handle → WindowError
        @active_handle = (h == PRIMARY_HANDLE ? nil : h)
      end
      def resize_window_to(handle, w, h) = window_browser!(handle).set_viewport(w, h)
      # Forem's ahoy-tracking spec calls `driver.resize(w, h)` directly
      # rather than through `current_window.resize_to`.
      def resize(w, h) = current_browser.set_viewport(w, h)
      # Both restore the window to the display it lives on (`Browser#screen_size`), which is where
      # it started — so they undo a `resize_to` rather than doing nothing. Coarse: we model no
      # window chrome, so a maximized window and a fullscreen one end up the same size (a real
      # browser's fullscreen is taller by the chrome it hides).
      def maximize_window(handle)   = restore_window_size(handle)
      def fullscreen_window(handle) = restore_window_size(handle)
      private def restore_window_size(handle)
        b = window_browser!(handle)
        b.set_viewport(*b.screen_size)
      end

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

      # A script's answer as Capybara hands it back: element handles as nodes, through hashes and arrays. One that holds
      # itself (a Window, an object with a reference back to it) has no answer: Capybara walks it as a tree.
      private def unwrap(value, path = nil)
        return value unless value.is_a?(Hash) || value.is_a?(Array)
        return Node.new(self, value['__elementHandle']) if value.is_a?(Hash) && value['__elementHandle']

        # (…the containers on the way down, made at the first one: most answers are scalars)
        path ||= {}.compare_by_identity
        raise Capybara::Simulated::CyclicScriptResult, 'cyclic object value' if path.key?(value)

        path[value] = true
        begin
          value.is_a?(Hash) ? value.transform_values {|v| unwrap(v, path) } : value.map {|v| unwrap(v, path) }
        ensure
          path.delete(value)
        end
      end

      def invalid_element_errors = [Capybara::Simulated::StaleElement, Capybara::Simulated::ClickIntercepted, Capybara::Simulated::ElementNotInteractable]
      def no_such_window_error   = Capybara::WindowError

      # A real raster of the laid-out page (see js/src/paint.js), not a serialization of it: the
      # painter reads the same boxes every geometry query reads, so a screenshot can only show
      # what the driver already believes. `full: true` paints the whole document rather than the
      # viewport.
      def save_screenshot(path, full: false, **_opts)
        data = current_browser.screenshot_png(full: full)
        raise Capybara::Simulated::ScreenshotFailed, 'screenshot: the page painted nothing' if data.nil?

        File.binwrite(path, data)
        path
      end

      def active_element
        handle = current_browser.active_element_handle
        handle ? Node.new(self, handle) : nil
      end

      # The session's emulated position (Capybara driver-level API; WebDriver BiDi "set emulated position data").
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
