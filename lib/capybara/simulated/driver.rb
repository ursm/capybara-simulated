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
        # Capture the universal-server flag ONCE, at session construction — the WPT
        # runner sets CSIM_LOCAL_ALL_HOSTS only while building the session, then
        # restores it. Every window (incl. aux windows opened later) inherits this so
        # cross-origin iframes eager-build consistently across the whole session.
        @all_hosts_local = ENV['CSIM_LOCAL_ALL_HOSTS'] == '1'
        @browser         = build_window_browser
        @browser.window_handle = PRIMARY_HANDLE
        @aux_windows     = []  # [{handle:, browser:, name:, opener:}, …]
        @active_handle   = nil
        @next_window_seq = 0
        # Driver-level blob URL partition map: url => {browser:, site:}. A blob URL's
        # storage partition is its creating context's top-level SITE; another window
        # can resolve the blob only from the same partition (and same origin, which
        # the blob: URL embeds). Bytes aren't copied here — they're read back from the
        # creating Browser's own store, so this stays a light reference map.
        @blob_partitions      = {}
        @blob_partitions_lock = Mutex.new
        @owner_thread    = Thread.current
        @@live_lock.synchronize { @@live << WeakRef.new(self) }
        @browser.default_viewport   = viewport   if viewport
        @browser.default_user_agent = user_agent if user_agent
      end

      private def build_window_browser
        Browser.new(@app,
                    driver:          self,
                    js_engine:       @js_engine,
                    cookies:         @cookies,
                    local_storage:   @local_storage,
                    all_hosts_local: @all_hosts_local)
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

      # Run one real-cadence event-loop frame and return the loop's observable
      # state. Drives "advance the page one frame" without the full poll tick
      # `evaluate_script` would incur per read; the wpt_runner uses it to drain a
      # page to completion at browser cadence.
      #
      # EVERY live window steps, not just the active one: an auxiliary window is a
      # separate VM, but the cross-context orchestration the dispatcher framework
      # builds on (a popup running an executor that polls a shared queue while the
      # opener waits) needs those background windows to make progress autonomously.
      # The active window's state leads; each aux window folds its progress / raf /
      # async / nearest-timer in so the caller keeps pumping while any window works.
      def run_event_loop_frame(frame_ms)
        state = current_browser.run_event_loop_frame(frame_ms)
        # Iterate a SNAPSHOT: a window's drain can open or close windows mid-loop (a
        # popup spawning another, or window.close disposing one). Re-check each window
        # is still open before stepping it, and isolate a per-window failure so one
        # dead/half-torn-down VM can't abort the whole frame pump.
        @aux_windows.dup.each do |w|
          b = w[:browser]
          next if b.equal?(current_browser)
          next unless @aux_windows.include?(w)   # closed earlier this loop → skip
          begin
            state = merge_frame_state(state, b.run_event_loop_frame(frame_ms))
          rescue StandardError
            next
          end
        end
        state
      end

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

      # Dispose every auxiliary window and return focus to the primary — a fresh
      # browsing context has no sibling windows. Disposing each aux Browser tears
      # down its worker / SSE / websocket threads and its V8 isolate eagerly; left
      # alone they pile into V8Runtime's process-wide `@@live` set and are only
      # reclaimed by the at_exit hook, which on a long-lived multi-file session
      # (the WPT runner) means a slow — sometimes minutes-long — process exit. Split
      # out of `reset!` so a caller can drop windows WITHOUT resetting the primary's
      # page state (the WPT runner rebuilds the primary itself, per file, via visit).
      def reset_windows!
        @aux_windows.each {|w| w[:browser].dispose rescue nil }
        @aux_windows.clear
        @active_handle = nil
        @blob_partitions_lock.synchronize { @blob_partitions.clear }
      end

      # Full teardown of the whole driver: aux windows AND the primary browser's
      # V8 isolate. `reset_windows!` deliberately keeps the primary alive (the
      # per-test reset path rebuilds only its page); this is for permanently
      # DROPPING a session. A caller that nils its session without this leaks the
      # primary isolate — with its heap, canvas pixel buffers, and worker threads —
      # into V8Runtime's process-wide `@@live` until at_exit. The WPT runner recycles
      # the cross-origin session per `.sub.`/`.https.` file, so that leak is ~one
      # isolate per cross-origin file (hundreds over the suite); disposing here
      # incrementally is what reset_windows! already does for aux windows.
      def dispose
        reset_windows!
        @browser.dispose rescue nil
      end
      def go_back              = current_browser.go_back
      def go_forward           = current_browser.go_forward
      def reset_history!       = current_browser.reset_history!
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
        [PRIMARY_HANDLE] + @aux_windows.map {|w| w[:handle] }
      end

      # All window entries (primary + aux) as `{handle:, browser:, name:, opener:}`.
      private def window_entries
        [{handle: PRIMARY_HANDLE, browser: @browser, name: '', opener: nil}] + @aux_windows
      end

      # The Browser backing a handle, or nil if the window is closed/unknown.
      def window_browser(handle)
        window_entries.find {|w| w[:handle] == handle }&.fetch(:browser)
      end

      # Open (or, by `name`, reuse) an auxiliary window. `target="_blank"`
      # clicks and `window.open` both land here. A non-empty `name` that
      # matches an existing window navigates that window instead of opening a
      # new one (HTML window-name targeting); `opener_handle` records the
      # opener so the new window's `window.opener` resolves back to it.
      def open_aux_window(url = nil, name: nil, opener_handle: nil, source: nil, blob_snapshot: nil, post: nil, opener: false, referrer: nil)
        name = name.to_s
        # A blob: URL opened from a different storage partition is forced noopener
        # (cross-partition-navigation), overriding an explicit rel=opener — the new
        # top-level window is the blob's own partition (so the blob still loads), but
        # the opener relationship is severed.
        opener = false if opener && url.to_s.start_with?('blob:') && source && cross_partition_blob?(url, source)
        # A `<form target>` keeps its opener by default (unlike a `target=_blank`
        # LINK, which is noopener) — resolve the opener handle from the source.
        opener_handle ||= handle_for(source) if opener && source
        if !name.empty? && (existing = @aux_windows.find {|w| w[:name] == name })
          if post
            existing[:browser].navigate_post(url, post[:body], post[:content_type], referer: referrer)
          else
            navigate_window(existing[:browser], url, source: source)
          end
          return existing[:handle]
        end
        @next_window_seq += 1
        handle = "csim-window-#{@next_window_seq}"
        aux = build_window_browser
        aux.window_handle = handle
        # Register BEFORE visiting: the opened document's own boot scripts read
        # `window.opener`, which resolves through this entry — so the entry
        # (with its opener) must exist before `visit` runs those scripts.
        @aux_windows << {handle: handle, browser: aux, name: name, opener: opener_handle}
        if url && !url.empty?
          if post
            # A `<form target=_blank method=post>` loads the new window via POST,
            # carrying the opener's URL as referrer (unless rel=noreferrer → '').
            aux.navigate_post(url, post[:body], post[:content_type], referer: referrer)
          # A blob: URL isn't rack-navigable and its bytes live in the OPENER's
          # isolate — load the document directly from a click-time snapshot (a
          # deferred target=_blank nav may revoke the URL first) or, failing that,
          # the opener's blob store.
          elsif !(url.to_s.start_with?('blob:') && load_blob_into_window(aux, url, source, snapshot: blob_snapshot))
            # A form submission carries a referrer (the opener's URL) unless the
            # form opted out via rel=noreferrer (referrer: '').
            aux.visit(url, referer: referrer)
          end
        end
        handle
      rescue StandardError => e
        # Aux window URL-load failure (binary content, network error, …)
        # shouldn't tear down the test — the handle is already recorded so
        # `window_opened_by` succeeds; within_window assertions on
        # `current_url` may still pass through whatever `visit` managed to set
        # before raising.
        warn "[csim] open_aux_window(#{url.inspect}) raised: #{e.class}: #{e.message[0, 200]}"
        handle
      end

      # ── JS-facing window routing (called via Browser host fns) ──────
      # Each window is a separate Browser/VM, so a cross-window reference is a
      # proxy that forwards here; the Driver routes to the target Browser.

      # `window.open(url, name)` from the `opener` window's JS. Resolves the URL
      # against the opener's document and records the opener relationship.
      def open_window_from_js(opener_browser, url, name, opener_realm_id = 0)
        resolved = url.to_s.empty? ? nil : opener_browser.resolve_document_url(url)
        # Opening a blob: URL whose storage partition differs from the opener's
        # top-level site is forced NOOPENER (cross-partition-navigation): the new
        # auxiliary window is its own top-level context in the blob's partition, so the
        # blob still loads — but there is no opener relationship and `window.open`
        # returns null. Same-partition keeps the normal opener.
        if resolved.to_s.start_with?('blob:') && cross_partition_blob?(resolved, opener_browser)
          open_aux_window(resolved, name: name, source: opener_browser)   # no opener_handle ⇒ window.opener null
          return nil                                                      # window.open(...) === null
        end
        # Same-origin window → a realm in the opener's isolate (shared heap); the
        # returned realm-id context becomes a native WindowProxy on the JS side, so
        # cross-window scripting/adoption need no cross-isolate RPC. The opener's realm
        # id wires the popup's window.opener. Falls through to the separate-VM aux path
        # (cross-origin, or a URL we don't yet realm-load).
        if (rid = opener_browser.open_window_realm(resolved, name: name, opener_realm_id: opener_realm_id))
          return rid
        end
        open_aux_window(resolved, name: name, opener_handle: handle_for(opener_browser), source: opener_browser)
      end

      # The storage-partition site a blob: URL was created in (its creator's top-level
      # site), or nil for an unknown / revoked / unpartitioned URL.
      def blob_partition_site_of(url)
        e = @blob_partitions_lock.synchronize { @blob_partitions[url.to_s] }
        e && e[:site]
      end

      # Is this blob: URL in a different storage partition than `accessor`'s top-level
      # site? Unknown blobs (no entry) are treated as same-partition (no extra gating
      # beyond the existing same-origin behaviour).
      def cross_partition_blob?(url, accessor)
        site = blob_partition_site_of(url)
        !site.nil? && site != accessor.blob_partition_site
      end

      # Resolve a blob: URL's bytes from whichever Browser created it (the bytes live
      # in the creator's isolate, not necessarily the navigator's). Used to load a blob
      # document into a TOP-LEVEL window (window.open / a window navigation): that new
      # context is the blob's own partition, so no partition gate applies here — the
      # cross-partition rule for windows is the noopener severing above, and for nested
      # frames it is enforced at the frame-navigation site. Falls back to the
      # accessor's own store for an unpartitioned URL (worker / legacy path).
      def blob_bytes_for(url, accessor)
        entry = @blob_partitions_lock.synchronize { @blob_partitions[url.to_s] }
        creator = entry ? entry[:browser] : accessor
        creator.respond_to?(:read_blob_for_window) ? creator.read_blob_for_window(url) : nil
      end

      # Record / drop a blob URL's storage partition (called by Browser#blob_register /
      # #blob_unregister). `site` is the creating context's top-level site.
      def register_blob_partition(url, browser, site)
        @blob_partitions_lock.synchronize { @blob_partitions[url.to_s] = {browser: browser, site: site.to_s} }
      end

      def unregister_blob_partition(url)
        @blob_partitions_lock.synchronize { @blob_partitions.delete(url.to_s) }
      end

      # A user `URL.revokeObjectURL(url)` from `source`. Storage-partitioned: a revoke
      # from a different top-level site than the blob's is a NO-OP (cross-partition.https
      # "shouldn't be revocable from a cross-partition iframe/worker"). A same-partition
      # revoke drops the Driver entry AND invalidates the blob in the CREATOR's isolate
      # (the blob may have been created in another window), so every window stops
      # resolving it. Returns false when vetoed (caller leaves its local copy intact).
      def revoke_blob_partitioned(url, source)
        entry = @blob_partitions_lock.synchronize { @blob_partitions[url.to_s] }
        return false if entry && entry[:site] != source.blob_partition_site
        @blob_partitions_lock.synchronize { @blob_partitions.delete(url.to_s) }
        creator = entry && entry[:browser]
        creator.drop_local_blob(url.to_s) if creator && creator.respond_to?(:drop_local_blob) && !creator.equal?(source)
        true
      end

      # Load a blob: document into top-level window `target`. The bytes live in
      # whichever Browser created the blob, not the target's — `blob_bytes_for` fetches
      # them cross-isolate. Returns false when the blob is unavailable (revoked), so
      # the caller falls back. A click-time `snapshot` is the navigating context's own
      # blob captured before a deferred nav could revoke it.
      private def load_blob_into_window(target, url, source, snapshot: nil)
        data = if snapshot.is_a?(Hash) && snapshot['b64']
          { bytes: Base64.decode64(snapshot['b64'].to_s), type: snapshot['type'].to_s }
        else
          blob_bytes_for(url, source)
        end
        return false unless data
        target.boot_blob_document(url, data[:bytes], data[:type])
        true
      rescue StandardError
        false
      end

      # `targetWindow.postMessage(data, origin)` — queue on the target window's
      # Browser, tagged with the source window's handle.
      def window_post_message(source_browser, target_handle, data, _origin)
        target = window_browser(target_handle) or return
        target.enqueue_window_message(data, _origin, handle_for(source_browser))
      end

      # `BroadcastChannel.postMessage` — deliver to every OTHER window's channels
      # with the same name (same-window delivery is handled in-VM by the sender).
      def broadcast_channel(source_browser, name, data)
        window_entries.each do |w|
          next if w[:browser].equal?(source_browser)
          w[:browser].enqueue_broadcast(name, data)
        end
      end

      def window_location(handle)        = (window_browser(handle)&.current_url).to_s
      # A cross-window property read (`win.foo` / `win.document.foo`) — read the
      # primitive off the target window's VM.
      def window_read(handle, prop, doc: false)
        b = window_browser(handle) or return nil
        b.read_property(prop, doc: doc)
      end
      # Cross-window remote-ref RPC: route a node/object proxy op to the window
      # that owns the ref (handle), executing in that window's VM.
      def fire_aux_window_load(handle)             = ((b = window_browser(handle)) && b.fire_own_window_load)
      def window_ref_get(handle, id, prop)         = (b = window_browser(handle)) ? b.remote_ref_get(id, prop) : nil
      def window_ref_set(handle, id, prop, value)  = ((b = window_browser(handle)) && b.remote_ref_set(id, prop, value))
      def window_ref_call(handle, id, method, args) = (b = window_browser(handle)) ? b.remote_ref_call(id, method, args) : nil
      def window_set_location(handle, url)
        b = window_browser(handle) or return
        # Per HTML, `w.location = url` parses `url` relative to the ENTRY settings
        # object — the document of the script doing the assignment (the active
        # window) — NOT the target window's current document. So a cross-window
        # `w.location.href = 'resources/x.html'` resolves against the opener's
        # base, not the aux's (which would double a shared path segment).
        navigate_window(b, current_browser.resolve_document_url(url), source: current_browser)
      end
      # A cross-window `w.history.back()/forward()/go(n)`: traverse the target
      # window's history. The opener's VM is the one executing, so a non-active
      # target can rebuild eagerly (like `navigate_window`); an active target
      # (e.g. `opener.history.back()` from an aux) defers to avoid tearing down
      # the running VM mid-call. Returns true when the traversal crossed a
      # document boundary — the JS proxy then fires the target's deferred `load`
      # (the same deferral as `navAux`) so the restored page's `window.onload`
      # runs after the opener's current task. False for a same-document
      # (pushState) traversal — popstate already fired — or a no-op.
      def window_history_go(handle, delta)
        b = window_browser(handle) or return false
        if b.equal?(current_browser)
          # `opener.history.back()` targeting the active window: defer (can't
          # rebuild the running VM mid-call) and return false — the active
          # window's load fires through its own navigation path when the pending
          # traversal drains, NOT via the aux-load deferral the caller would run.
          b.history_go(delta)
          false
        else
          b.history_go(delta, force: true) == :cross_document
        end
      end
      def window_closed?(handle)         = window_browser(handle).nil?
      def opener_handle_of(browser)
        handle = handle_for(browser)
        window_entries.find {|w| w[:handle] == handle }&.fetch(:opener)
      end
      private def handle_for(browser) = browser.window_handle

      # Navigate an existing window. If it's the window whose JS is currently
      # executing — a self-targeted `window.open(url, ownName)` or
      # `someProxyToSelf.location = …` — DEFER via the location-assign queue:
      # navigating it synchronously (`visit` → `rebuild_ctx`) would dispose the
      # V8 context mid-call and abort the running handler. A non-active window
      # can navigate immediately (its VM isn't on the stack).
      private def navigate_window(browser, url, source: nil)
        return if url.nil? || url.to_s.empty?
        # A blob: navigation loads directly from the opener's blob bytes (not
        # rack-navigable, cross-isolate). Only when the target isn't the active
        # window (boot rebuilds its ctx — unsafe mid-call on the running window).
        if url.to_s.start_with?('blob:') && !browser.equal?(current_browser) &&
           load_blob_into_window(browser, url, source)
          return
        end
        if browser.equal?(current_browser)
          browser.location_assign(url)
        else
          browser.visit(url)
        end
      end

      # Capybara `Session#open_new_window(:tab)` entry point — opens at
      # `about:blank` (so `current_url`/title match a real new tab) and the
      # test then `switch_to_window` + `visit`s the real URL. We don't
      # distinguish `:tab` from `:window` (no window-chrome semantics here).
      def open_new_window(_kind = :tab)
        open_aux_window('about:blank')
      end
      def window_size(_)           = [current_browser.viewport_width, current_browser.viewport_height]
      def close_window(h)
        return if h == PRIMARY_HANDLE
        @aux_windows.reject! {|w|
          next false unless w[:handle] == h
          drop_blob_partitions_for(w[:browser])   # don't leave entries pointing at a disposed VM
          w[:browser].dispose rescue nil
          true
        }
        @active_handle = nil if @active_handle == h
      end

      # Drop every blob-partition entry created by `browser` — its isolate is being
      # disposed, so the bytes are gone and the reference must not linger (a stale
      # entry would pin the dead Browser and route blob_bytes_for to a dead VM).
      private def drop_blob_partitions_for(browser)
        @blob_partitions_lock.synchronize do
          @blob_partitions.reject! {|_url, e| e[:browser].equal?(browser) }
        end
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
