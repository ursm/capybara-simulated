# frozen_string_literal: true

require 'base64'
require 'date'
require 'fileutils'
require 'json'
require 'net/http'
require 'openssl'
require 'rack/mock'
require 'socket'
require 'thread'
require 'time'
require 'uri'
require_relative 'asset_cache'
require_relative 'errors'
require_relative 'stack_resolver'
require_relative 'trace'
require_relative 'webauthn_state'

module Capybara
  module Simulated
    class Browser
      # Fallback origin for `visit('/foo')` and friends when no current
      # page is loaded yet. Track Capybara's idea of the test server
      # (`app_host` if set, else explicitly-configured `server_host` /
      # `server_port`) so the host header reaching the Rack app matches
      # what host-specific helpers expect — Discourse's
      # `setup_system_test` sets `SiteSetting.force_hostname =
      # Capybara.server_host` / `port = Capybara.server_port`, and the
      # request-tracker specs assert `event[:url] ==
      # Discourse.base_url_no_prefix + path`, which derives from the
      # same SiteSetting pair. We only consult `server_host` when it
      # was *explicitly* set: Capybara's getter returns `'127.0.0.1'`
      # when unset, but Rack::Test's hardcoded default origin is
      # `www.example.com` and capybara's own shared specs hard-code
      # that literal — fall back to it when no suite-side configuration
      # is in play.
      def self.default_host
        return ::Capybara.app_host if ::Capybara.app_host
        host = ::Capybara.server_host
        return 'http://www.example.com' if host == '127.0.0.1'
        port = ::Capybara.server_port.to_i
        port > 0 ? "http://#{host}:#{port}" : "http://#{host}"
      end

      # Process-wide HTTP/1.1 response cache for `rack_fetch`. Real
      # browsers (cuprite / selenium) reuse fetched assets across the
      # suite — without this, Simulated re-fetches every <script src>
      # on every visit (Redmine baseline: ~6× more requests than
      # selenium). Honors `Cache-Control` / `Expires` / `ETag` /
      # `Last-Modified` per RFC 9111.
      @@asset_cache = AssetCache.new

      attr_writer :timers_active

      # Sticky window after timers finish: keep polling? true so a
      # setTimeout firing mid-loop doesn't drop Capybara's synchronize
      # before its own default_max_wait_time kicks in. Counted in poll
      # calls (not wall time) for determinism under GC/load pressure.
      # 1000 polls × Capybara's default 0.01 s retry_interval ≈ 10 s.
      POLLING_GRACE_POLLS = 1000
      # When `@timers_active` is true but `@runtime.settle_gen` hasn't
      # bumped in this many consecutive polls, treat the page as
      # observably idle and let Capybara's per-find timer give up. See
      # `polling?` for the full rationale. 300 polls ≈ 3 s at
      # Capybara's default 10 ms retry interval — long enough to ride
      # through brief async idle windows during Discourse's
      # ProseMirror editor boot (which sometimes pauses ~1 s mid-load
      # while a webpack chunk + Glimmer reconcile complete) while
      # still cutting the full 4 s wait on tests destined to fail.
      IDLE_SETTLE_POLLS = 300
      # Brief window after a Ruby-side navigate (context rebuild) so
      # Capybara's outer synchronize gets one retry against the new
      # context.
      POST_NAV_POLL_GRACE_POLLS = 10
      # Fallback fixed step when wall-elapsed is 0 ms (e.g. nested
      # tick calls from the same Ruby boundary, or a brand-new
      # session whose last_tick_ts has just been initialised). Kept
      # tiny so a same-frame double-call doesn't accidentally fire
      # debounces; the wall-sync path in `tick_real_time` is the
      # main clock driver.
      TICK_STEP_MS = 50
      SETTLE_DRAIN_MS = 32
      SETTLE_MAX_ITER = 10
      # Per-`run_loop_step` task cap (its `maxIter`). Bounds a self-rescheduling
      # timer/microtask storm so one settle iter returns to Ruby; large enough
      # for the heaviest legit chain (Mastodon hydrate, Turbo stream batch).
      SETTLE_MAX_ITER_TASKS = 256
      # Post-user-action virtual-clock advance. Default 0 — the
      # wall-sync model (each tick_real_time advances by the wall
      # ms elapsed since the last tick) lets Capybara's outer poll
      # loop drive the clock at the same rate a real browser sees,
      # so debounced chains complete naturally during polling
      # without being pre-emptively flushed past the transient
      # window real-browser tests rely on.
      #
      # `CSIM_USER_ACTION_DRAIN_MS=600` restores the pre-wall-sync
      # burst behaviour: post-action, drain everything due in the next
      # 600 ms of virtual time before returning. Costs the transient-
      # state observability the wall-sync model preserves; recovers
      # the ~5-10 % wall on action-heavy suites where Capybara would
      # otherwise poll N times to catch a single debounce.
      USER_ACTION_DRAIN_MS = (ENV['CSIM_USER_ACTION_DRAIN_MS'] || '0').to_i
      # Upper bound on a single tick's virtual advance. Prevents a
      # long Ruby pause (asset compile, debugger break) from being
      # replayed as one giant drain that fires every debounce in
      # the queue at once.
      MAX_TICK_MS = 1000
      # Per-iter microtask drain depth. mini_racer drains one round
      # per `eval` boundary, so this is the supported chained-await
      # depth before we punt to drain_timers and let the virtual clock
      # advance. 4 covers Turbo's `await fetch → response → text →
      # stream` fan-out without blowing the per-iter cost.
      SETTLE_MICRO_DRAIN_PER_ITER = 4

      # Sent on every driver-originated Rack call. `HTTP_USER_AGENT`
      # must lead with `Mozilla/5.0` so server-side bot detectors
      # (ahoy_matey's `Browser.new(ua).bot?`) treat us as a real
      # client. `REMOTE_ADDR` has to be a non-empty, parseable IP —
      # Devise's `trackable` mixin runs `IPAddr.new(request.remote_ip)`
      # during `set_user`/sign-in, and an empty string trips
      # `IPAddr::AddressFamilyError`.
      # Keep `USER_AGENT` in sync with `navigator.userAgent` in
      # `lib/capybara/simulated/js/bridge.js` — the JS side ships in the V8
      # snapshot, so injecting from Ruby at boot would defeat snapshot
      # warmth.
      # Discourse's `non_crawler_user_agents` adds a "Rails Testing"
      # bypass in test mode (see lib/crawler_detection.rb); without one
      # of its bypass tokens here Discourse serves a no-JS crawler-only
      # HTML view. Putting "Rails Testing" in the UA satisfies that
      # without claiming a specific real-browser engine (which would
      # send Turbo / Stimulus down chrome-specific code paths Avo's
      # tests don't exercise).
      USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 capybara-simulated'
      # Approximate Chrome's resolution: when connecting to `localhost`,
      # Linux glibc returns IPv6 (::1) first and the server sees the
      # client at `::1`; for any literal IP (or a non-localhost name),
      # the server keeps IPv4. Match that so Discourse system specs
      # (`expect(event[:ip_address]).to eq('::1')`) line up with what
      # they would see under selenium.
      REMOTE_ADDR_IPV4 = '127.0.0.1'
      REMOTE_ADDR_IPV6 = '::1'
      def self.remote_addr_for(host)
        bare = host.to_s.downcase.sub(/:\d+\z/, '').sub(/\A\[(.+)\]\z/, '\1')
        bare == 'localhost' ? REMOTE_ADDR_IPV6 : REMOTE_ADDR_IPV4
      end

      def mime_type_for_path(path)
        Rack::Mime.mime_type(File.extname(path.to_s), '')
      end

      def initialize(app, driver: nil, js_engine: nil, cookies: nil, local_storage: nil)
        @app                          = app
        @driver                       = driver
        @runtime                      = build_runtime(js_engine)
        @current_url                  = nil
        # Real browsers yield control between asynchronous URL
        # transitions (XHR-driven model loads, then `replaceWith` to a
        # child route), so Capybara polls catch the intermediate URL —
        # e.g. Discourse's `/wizard` → `/wizard/steps/setup` flow holds
        # at `/wizard` while `Wizard.load()` runs. Our env drains
        # microtasks synchronously and only the final URL is reachable
        # by the time Ruby regains control. Queue URLs we transitioned
        # through; `current_url` shifts one out per call so a polling
        # `assert_current_path` walks the same set the real browser
        # would have observed.
        @recent_urls                  = []
        @recent_urls_last_push_at     = nil
        # The URL of the page that navigated to the current document —
        # HTTP `Referer` header on the response that loaded the page,
        # exposed to JS as `document.referrer`. Tracked by `navigate`
        # so post-auth flows (Discourse login: `cookie('destination_url',
        # referrer)` when navigating from `/t/N` → `/login` via link
        # click) can reconstruct the origin URL.
        @current_referer              = ''
        # Cookies + localStorage are origin-shared in real browsers —
        # the Driver injects the jars so aux windows (per-window VMs)
        # see the same auth state and storage as the primary. Tests
        # without a Driver (gem-internal callers) get fresh jars.
        @cookies                      = cookies       || {}
        @local_storage                = local_storage || {}
        @session_storage              = {}
        @sticky_headers               = {}
        @timers_active                = false
        # Capybara config is set once per suite; cache the derived
        # origin so the per-request fallback path doesn't re-dispatch
        # `Capybara.app_host` / `server_host` / `server_port` on every
        # rack call (CLAUDE.md: cache env decisions at construction).
        @default_host                 = self.class.default_host
        # Handle IDs are per-Context integer sequences: a handle from
        # a pre-rebuild context could collide with a fresh node's id
        # in the new context. Node captures this on construction;
        # `check_stale` rejects on mismatch.
        @context_gen                  = 0
        @find_cache_dirty             = true
        @find_cache_kind              = nil
        @find_cache_arg               = nil
        @find_cache_ctx               = nil
        @find_cache_value             = nil
        @document_handle              = 0
        @last_tick_ts                 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @polling_grace                = nil
        @last_polled_gen              = nil
        @idle_settle_polls            = 0
        @ticking                      = false
        @history                      = []
        @history_idx                  = -1
        @modal_handlers               = []
        # Geolocation override (CDP-ish). nil = no override configured →
        # navigator.geolocation reports POSITION_UNAVAILABLE. Ruby-backed so
        # it survives the per-call VM rebuilds, like web storage. Read by the
        # `__csimGeolocationState` host fn.
        @geolocation                  = nil
        # Per-test action trace. `@trace` is the live recorder; `reset!`
        # moves it to `@pending_trace` so an after-hook running after
        # session reset still has access. `@trace_mode` is cached at
        # construction so `record_action`'s hot path doesn't pay an
        # ENV lookup.
        #
        # `CSIM_TRACE=off|on-failure|full` (default `on-failure`):
        # - `off`       — no recording at all; `record_action` early-exits.
        # - `on-failure` — record kind/url/console/network in-memory;
        #                  snapshot `dom_after` only on action error.
        # - `full`      — record + snapshot DOM after every action
        #                 (debug-heavy).
        # File output is orthogonal — `CSIM_TRACE_DIR=path` makes the
        # test-runner hook persist the trace JSON there; unset means
        # in-memory only (no files written without explicit opt-in).
        @trace            = nil
        @pending_trace    = nil
        @recording_action = false
        @trace_mode       = parse_trace_mode(ENV['CSIM_TRACE'])
        # EventSource (SSE) — per-Browser handle counter, background
        # reader threads, and a thread-safe Queue of parsed events
        # awaiting delivery into the VM. Threads do the long-lived
        # HTTP read; the main thread polls the Queue in `settle` and
        # dispatches via `__csim_deliverEventSourceEvents`.
        @event_source_seq     = 0
        @event_source_threads = {}
        @event_source_queue   = Thread::Queue.new
        # Hijacked-XHR delivery — per-Browser handle counter,
        # background threads, and a Queue of completed responses for
        # Rack calls where the middleware used `rack.hijack` to hold
        # the connection open (the contract `message_bus`'s long-poll
        # uses to push publishes immediately rather than waiting for
        # the next client poll). Same shape as SSE: the thread reads
        # the hijacked pipe; main settle drains the Queue and
        # dispatches via `__csim_deliverHijackedFetches`.
        @hijack_fetch_seq     = 0
        @hijack_fetch_threads = {}
        @hijack_fetch_queue   = Thread::Queue.new
        # Web Workers — per-Browser handle counter, per-worker
        # {thread, inbox} pair, and a shared outbox the main settle
        # drains via `__csim_deliverWorkerMessages`. Each worker
        # thread owns its own V8 Context / QuickJS VM (real isolate);
        # cross-isolate messaging is JSON-marshalled.
        @worker_seq    = 0
        @workers       = {}
        @worker_outbox = Thread::Queue.new
        # Outstanding posts-to-worker; `polling?` stays true while > 0
        # so long-running compute (e.g. mozjpeg over an 8900×8900 frame)
        # isn't starved by the settle_gen idle gate.
        @worker_in_flight = 0
        # Cross-isolate `blob:` store. Worker isolates can't see the
        # main scope's `__csimBlobs` Map, so we mirror bytes here and
        # workers resolve them through a host fn.
        @blob_registry = {}
        @blob_registry_lock = Mutex.new
        # Postmessage transferable-buffer store. Large Uint8Array /
        # ArrayBuffer payloads cross isolates as a Ruby-side byte ID
        # rather than a JSON base64 string, so peak JS heap stays flat.
        @transfer_buffer_lock = Mutex.new
        @transfer_buffers     = {}
        @transfer_buffer_seq  = 0
      end

      # Worker thread polling and termination intervals — split so a
      # tuning change to one doesn't accidentally rebind the other.
      WORKER_POLL_INTERVAL   = 0.05
      WORKER_TERMINATE_GRACE = 0.05
      private_constant :WORKER_POLL_INTERVAL, :WORKER_TERMINATE_GRACE

      # `js_engine` picks the JS runtime: `:v8` (mini_racer, fastest
      # per-spec) or `:quickjs` (quickjs.rb, smaller per-VM footprint —
      # wins on parallelism). Both gems are soft dependencies; pass nil
      # to auto-select whichever is installed.
      ENGINE_GEM = {v8: 'mini_racer', quickjs: 'quickjs'}.freeze
      private_constant :ENGINE_GEM

      def build_runtime(engine)
        engine ||= detect_js_engine
        case engine
        when :v8
          require_relative 'v8_runtime'
          V8Runtime.new(self)
        when :quickjs
          require_relative 'quickjs_runtime'
          QuickJSRuntime.new(self)
        else
          raise ArgumentError, "unknown CSIM_JS_ENGINE #{engine.inspect}; expected one of #{JS_ENGINES.inspect}"
        end
      end

      # Iterate `JS_ENGINES` in preference order — V8 first because
      # JIT wins per-spec wall time, QuickJS second when only the
      # smaller-footprint engine is installed.
      private def detect_js_engine
        JS_ENGINES.find {|e| Gem.loaded_specs.key?(ENGINE_GEM.fetch(e)) } ||
          raise(LoadError, "capybara-simulated needs a JS engine: add one of #{ENGINE_GEM.values.map {|g| "`gem '#{g}'`" }.join(' / ')} to your Gemfile")
      end

      # ── Capybara DSL surface ────────────────────────────────────

      # Address-bar navigation: no Referer, and relative paths resolve
      # against the host root (not the current page's directory).
      def visit(url)
        navigate(resolve_visit_url(url), referer: nil)
      end

      URL_UNSAFE_CHARS = %r{[^!*'();:@&=+$,/?#\[\]A-Za-z0-9\-._~%]}n.freeze
      private_constant :URL_UNSAFE_CHARS

      def resolve_visit_url(url)
        s = url.to_s
        unless s =~ %r{\A[a-z]+://}i
          host_root = (begin URI.parse(@current_url) rescue nil end)&.tap {|u| u.path = ''; u.query = nil; u.fragment = nil }&.to_s || @default_host
          host_root = host_root.sub(/\/+$/, '')
          s = "/#{s}" unless s.start_with?('/')
          s = "#{host_root}#{s}"
        end
        # Real browsers percent-encode characters that aren't legal in their
        # URL position before issuing the request. Skip the escape pass when
        # the input is already clean (the common case).
        s.match?(URL_UNSAFE_CHARS) ? URI::DEFAULT_PARSER.escape(s, URL_UNSAFE_CHARS) : s
      end

      # Queued URLs older than this (real wall clock) are treated as
      # stale and dropped on the next `current_url` read. Capybara's
      # default polling interval is 50 ms, so a `have_current_path`
      # walk runs through its iterations well under this threshold;
      # a `page.current_url` read between unrelated user actions
      # arrives long after the prior action's settle pushed
      # intermediates, falls past the cutoff, and surfaces the
      # current URL directly.
      RECENT_URLS_STALE_AGE_MS = 250

      def current_url
        tick_real_time
        # `tick_real_time` may have queued URL transitions via
        # `record_url_transition`. A polling matcher
        # (`have_current_path`) calls here once per ~50 ms iteration
        # and shifts one entry per call so it walks the same
        # intermediate-URL chain a real browser would have observed
        # before microtasks all collapsed onto the final URL — the
        # finish_installation_spec wizard chain depends on this for
        # the `/wizard` step before the JS replaceWith to
        # `/wizard/steps/setup` lands. A non-polling read
        # (`topic_url = page.current_url` long after the prior
        # action's settle) just wants the current URL; drop entries
        # older than the polling-cadence window so they don't leak
        # into an unrelated call (tags_spec:221's composer-submit
        # leaves `/new-topic` queued, and the read happens minutes
        # of test wall-clock later).
        if @recent_urls_last_push_at && @recent_urls.any?
          age_ms = Process.clock_gettime(Process::CLOCK_MONOTONIC, :millisecond) - @recent_urls_last_push_at
          @recent_urls.clear if age_ms > RECENT_URLS_STALE_AGE_MS
        end
        return @recent_urls.shift if @recent_urls.any?
        @current_url || ''
      end

      # Called whenever `@current_url` is about to be set to a new
      # value during a page-load drain or a settle tick driven by a
      # user action; queues the prior URL for surface-via-
      # `current_url` so a polling matcher walks the intermediate
      # chain. Out-of-band JS-driven pushStates
      # (`execute_script("history.pushState(...)")`) bypass the queue —
      # they have no chain of microtask-driven transitions to walk,
      # and the caller expects to read the new URL one-shot. Bounded
      # to size 8 to guard against runaway chains; `current_url`'s
      # staleness check drops the rest on any read past the polling-
      # cadence window. Without the queue the finish_installation
      # wizard chain's intermediate `/wizard` would be invisible:
      # the JS-side `replaceWith` to `/wizard/steps/setup` lands
      # during a tick, so by the time Capybara polls `@current_url`
      # is already the final URL.
      def record_url_transition(new_url)
        return unless @ticking || @navigating
        old = @current_url
        return if old.nil? || old.to_s.empty?
        return if old.to_s == new_url.to_s
        @recent_urls << old.to_s
        @recent_urls.shift while @recent_urls.size > 8
        @recent_urls_last_push_at = Process.clock_gettime(Process::CLOCK_MONOTONIC, :millisecond)
      end

      def find_css(css, context_handle = nil)
        s = css.to_s
        return find_xpath(s, context_handle) if xpath_shaped?(s)
        find_with_timer_fallback(:css, s, context_handle) do
          @runtime.call('__csimQuery', context_handle || @document_handle, s).to_a
        rescue StandardError => e
          # Invalid selector → empty result. Callers that genuinely
          # need the throw go through `evaluate_script`.
          raise unless syntax_or_invalid_selector_error?(e)
          []
        end
      end

      def find_first_css(css, context_handle = nil)
        s = css.to_s
        find_with_timer_fallback(:css_first, s, context_handle) do
          h = @runtime.call('__csimQueryOne', context_handle || @document_handle, s).to_i
          h.zero? ? nil : h
        rescue StandardError => e
          raise unless syntax_or_invalid_selector_error?(e)
          nil
        end
      end

      # JS-side selector parser throws a `DOMException('csim: …',
      # 'SyntaxError')`. The JS engine surfaces it as a `…::SyntaxError`
      # (QuickJS via dynamic-named class) or, under mini_racer, a
      # `MiniRacer::RuntimeError` whose message is `"SyntaxError: csim: …"`.
      # Match the `csim: ` marker anywhere in the message (it's no longer at
      # the start once the DOMException name is prefixed) or the class suffix,
      # so neither gem becomes a hard dependency.
      def syntax_or_invalid_selector_error?(e)
        e.class.name.to_s.end_with?('::SyntaxError') ||
          e.message.to_s.include?('csim: ')
      end

      def xpath_shaped?(s)
        # Cheap probe: anything starting with `/` (absolute or relative
        # XPath), `(` (grouped XPath like `(//a)[1]`), or `./` /
        # `..` (XPath current-node + step) is XPath. We can't treat a
        # bare leading `.` as XPath because CSS class selectors look
        # exactly like that (`.contextual`); only the `./` form is
        # unambiguous.
        !!(s =~ %r{\A\s*(?:/|\(\s*/|\./|\.\.)})
      end

      # XPath is evaluated *inside* V8 against the live JS DOM via
      # the xpathway engine (bundled, installed at snapshot build). One IPC per
      # `find_xpath` — no serialise + reparse round-trip.
      def find_xpath(xpath, context_handle = nil)
        xpath_str = xpath.to_s
        find_with_timer_fallback(:xpath, xpath_str, context_handle) do
          @runtime.call('__csimEvaluateXPath', xpath_str, context_handle || 0).to_a
        end
      end

      def find_with_timer_fallback(kind, arg, ctx)
        tick_real_time if timer_wait_elapsed?
        result = cached_find(kind, arg, ctx) { yield }
        return result unless empty_find_result?(result) && @timers_active

        tick_real_time
        return result unless @find_cache_dirty

        cached_find(kind, arg, ctx) { yield }
      end

      def empty_find_result?(result)
        result.nil? || (result.respond_to?(:empty?) && result.empty?)
      end

      # Minimum wall-clock gap before find() re-ticks. The smoke
      # contract is "first find returns the current DOM without
      # firing pending timers" — apps assert `have_selector` on a
      # `<div>` whose constructor schedules a `setTimeout(0)` to
      # remove it, expecting to catch the div before removal. Keep
      # this above one Ruby boundary so a single visit+find pair
      # doesn't accidentally tick.
      FIND_PRE_TICK_MIN_S = 0.05
      def timer_wait_elapsed?
        @timers_active &&
          (Process.clock_gettime(Process::CLOCK_MONOTONIC) - @last_tick_ts) >= FIND_PRE_TICK_MIN_S
      end

      # Cheap O(1) gate: is there any non-timer async channel with traffic
      # that `tick_real_time` would drain? `tick_real_time` itself runs
      # exactly when `worker_pending? || event_source_pending? ||
      # hijack_fetch_pending?` (plus `@timers_active`), and each of those
      # predicates is a single `.empty?` / counter check. Reusing them
      # here lets an attribute poll whose value is delivered only by a
      # Worker / SSE / hijacked-fetch message (with no active timer) still
      # drain that channel, without paying an unconditional drain on
      # timer-driven runloop pages.
      def async_io_pending?
        worker_pending? || event_source_pending? || hijack_fetch_pending?
      end

      # Single-slot cache for the most recent find_xpath / find_css /
      # find_first_css result. Capybara's `synchronize` retry loop
      # re-issues the same find on every poll while waiting for an
      # element to appear or disappear; if no DOM-mutating event has
      # happened since the last call (no timer fired, no click / set /
      # navigate), the result is guaranteed identical and we can skip
      # the V8 round-trip + xpathway traversal.
      def cached_find(kind, arg, ctx)
        if !@find_cache_dirty &&
           @find_cache_kind == kind &&
           @find_cache_ctx  == ctx &&
           @find_cache_arg  == arg
          return @find_cache_value
        end
        result = yield
        @find_cache_kind  = kind
        @find_cache_arg   = arg
        @find_cache_ctx   = ctx
        @find_cache_value = result
        @find_cache_dirty = false
        result
      end

      # Any operation that may have mutated the DOM (click, set,
      # send_keys, navigate, hover, …) must call this so the next find
      # falls through to a fresh V8 query. Timer drains that fire any
      # callbacks also dirty (see `tick_real_time`).
      def invalidate_find_cache
        @find_cache_dirty = true
      end

      def text(handle)        = @runtime.call('__csimText', handle).to_s
      def tag(handle)         = @runtime.call('__csimTag', handle).to_s
      def attr(handle, name)  = @runtime.call('__csimAttr', handle, name.to_s)
      def inner_html(handle)  = @runtime.call('__csimInnerHTML', handle).to_s
      def outer_html(handle)  = @runtime.call('__csimOuterHTML', handle).to_s
      def file_input?(handle)
        tag(handle) == 'input' && attr(handle, 'type').to_s.downcase == 'file'
      end
      def visible?(handle)    = @runtime.call('__csimVisible', handle) ? true : false

      # Capybara::Driver::Node surface — Node calls `check_stale`
      # before each read, and that advances the virtual clock.
      def all_text(handle)     = text(handle)
      def visible_text(handle) = @runtime.call('__csimVisibleText', handle).to_s
      def tag_name(handle)     = tag(handle)
      def value(handle)        = @runtime.call('__csimValue', handle)
      def disabled?(handle)    = @runtime.call('__csimDisabled', handle)
      # HTML spec: `<option>.selected` IDL is true when the `selected`
      # *attribute* is set OR when no sibling option has `selected` and
      # this is the first non-disabled option of a single-select
      # `<select>` (implicit default). Capybara's `have_select(selected:
      # "Choose an option")` filter calls `selected?` on each option;
      # without the implicit-default branch, a select with no explicit
      # `<option selected>` reports no selected options and the matcher
      # fails even though the first option *is* the currently chosen
      # one in real browsers.
      def option_selected?(h)  = !!@runtime.call('__csimOptionSelected', h)
      def shadow_root_handle(handle)
        h = @runtime.call('__csimShadowRoot', handle).to_i
        h.zero? ? nil : h
      end
      def computed_style(handle, names)
        tick_real_time
        result = @runtime.call('__csimComputedStyle', handle, names.map(&:to_s))
        return names.to_h {|n| [n, ''] } unless result.is_a?(Hash)
        result.transform_keys(&:to_s)
      end
      def node_path(handle)    = @runtime.call('__csimNodePath', handle).to_s

      def lookup_node(handle)
        handle if @runtime.call('__csimAlive', handle)
      end

      def check_stale(handle, initial, gen = nil)
        return if initial && (gen.nil? || gen == @context_gen) && @runtime.call('__csimAlive', handle)

        tick_real_time
        return if initial && (gen.nil? || gen == @context_gen) && @runtime.call('__csimAlive', handle)

        raise Capybara::Simulated::StaleElement, "Element with handle #{handle} is no longer attached to the document"
      end

      # `tick_real_time` may have rebuilt the DOM (Ember route hydration
      # finishing on its first idle tick replaces server-rendered nodes
      # with fresh ones). `Node` ran check_stale before calling here,
      # but that was BEFORE the tick — re-verify after so Capybara
      # catches the now-stale handle and retries the find. Otherwise
      # `__csim*` lookups would return null and the operation would
      # silently no-op (or, in the case of `__csimClickResolve`,
      # dispatch on a detached node whose listeners no longer matter).
      def ensure_alive_after_tick(handle)
        return if @runtime.call('__csimAlive', handle)
        raise Capybara::Simulated::StaleElement, "Element with handle #{handle} is no longer attached to the document"
      end

      def click(handle, keys = [], **opts)
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        init = click_event_init(handle, keys, opts)
        delay = opts[:delay].to_f
        action =
          if delay > 0
            # Wall-sleep between mousedown and mouseup so click handlers
            # reading `Date.now()` see the elapsed gap (selenium parity).
            init['mouseDownOnly'] = true
            partial = @runtime.call('__csimClickResolve', handle, init)
            sleep delay
            @runtime.call('__csimClickFinish', handle, partial.is_a?(Hash) ? partial['base'] : init)
          else
            @runtime.call('__csimClickResolve', handle, init)
          end
        unless action.is_a?(Hash)
          settle
          # Drain the download intent the click chain may have queued.
          # Avo's action-download path: form submit → Turbo applies a
          # turbo-stream → `StreamActions.download` → file-saver's
          # `saveAs` → `setTimeout(() => click(<a download>), 0)` →
          # our dispatchEvent default-action sets
          # `__csimPendingDownload`. Settle bails on the first
          # observable change (the stream-render mutation), so the
          # await-chain inside the stream's `connectedCallback`
          # (`await nextRepaint(); await performAction()` →
          # `setTimeout(click(a), 0)`) hasn't reached saveAs yet —
          # nudge it forward with a few alternating microtask /
          # timer drain rounds, then consume directly. (Can't route
          # via `tick_real_time`: post-drain `@timers_active` is
          # false and it bails before its own consume_pending_*
          # drains.)
          if @runtime.respond_to?(:drain_microtasks) && @runtime.respond_to?(:drain_timers)
            # Most clicks don't queue any timers; bail as soon as a
            # round drains nothing rather than burning the full 8 mini_racer
            # round-trips. Profile (Avo actions_spec / V8): the
            # unconditional loop cost ~7.7 % of wall time.
            8.times do
              @runtime.drain_microtasks(4)
              break if @runtime.drain_timers(50).to_i.zero?
            end
          end
          consume_pending_download
          # Discourse's `lib/click-track.js` preventDefaults link
          # clicks and routes navigation through `DiscourseURL
          # .redirectTo → window.location = href`, which our setter
          # parks on `@pending_location`. Drain it here so attachment
          # downloads from `click_link` complete inside the click
          # action.
          consume_pending_location
          return
        end
        case action['kind']
        when 'navigate'
          url = action['url'].to_s
          target = action['target'].to_s
          # `target="_blank"` (or any non-_self/_top/_parent name) opens
          # in a new browsing context. URL-only multi-window mode
          # records the URL against a fresh aux handle; the primary
          # stays put (per HTML spec — original window is unaffected).
          if !target.empty? && !%w[_self _top _parent].include?(target.downcase) && @driver.respond_to?(:open_aux_window)
            @driver.open_aux_window(resolve_against_current(url, use_base: true))
          # In-page anchor links (`#frag` / current-page + `#frag`) move
          # the hash but don't fetch a new document. Pure-fragment also
          # short-circuits the `<a>`s test fixtures use as click sinks.
          elsif pure_fragment_navigation?(url)
            update_current_hash(url)
          else
            # Drain any work the click handler queued before the VM gets
            # rebuilt — analytics libraries (Ahoy / segment / GA) queue
            # the event into a setTimeout-driven flush and rely on the
            # browser firing it before navigation tears their context
            # down. Without this drain the tracking POST is lost on
            # every internal link click.
            tick_real_time
            # Link clicks honour `<base href>` (HTML spec); `visit`
            # does not — that's address-bar navigation.
            navigate(resolve_against_current(url, use_base: true))
          end
        when 'submit'
          # Drain any work the click handler queued before the form
          # submission. Mastodon's logout flow: submit-button click
          # fires the form handler, which kicks off an axios DELETE for
          # `/auth/sign_out`; the response sets
          # `window.location.href = '/auth/sign_in'`. Without the
          # drain, we'd submit the form (no `action` attr → current
          # URL, e.g. `/start`) before the XHR resolves, landing on
          # the wrong page. Loop matches the navigate branch — bail
          # as soon as a drain round fires nothing.
          submit_baseline_url = @current_url
          if @runtime.respond_to?(:drain_microtasks) && @runtime.respond_to?(:drain_timers)
            8.times do
              @runtime.drain_microtasks(4)
              break if @runtime.drain_timers(50).to_i.zero?
            end
          end
          # If the drain queued or consumed a `location.assign`, that
          # navigation supersedes the form's default submit. Honour
          # pending; if `@current_url` already changed mid-drain (the
          # navigate landed during a timer fire), skip the form submit
          # entirely — its form handle is in a stale VM by now.
          if @pending_location
            consume_pending_location
          elsif @current_url != submit_baseline_url
            # Already navigated; nothing more to do.
          else
            submit_form_handle(action['formHandle'], action['submitter'])
          end
        when 'download'
          download_link(resolve_against_current(action['url'].to_s), action['filename'].to_s)
        end
      end

      def download_link(url, filename_hint = '')
        env = Rack::MockRequest.env_for(url, method: 'GET')
        env['HTTP_USER_AGENT'] = @default_user_agent || USER_AGENT
        env['REMOTE_ADDR']     = self.class.remote_addr_for(env['HTTP_HOST'] || env['SERVER_NAME'])
        env['HTTP_COOKIE']     = document_cookie unless @cookies.empty?
        env['HTTP_REFERER']    = @current_url    unless @current_url.nil? || @current_url.empty?
        status, headers, body = @app.call(env)
        return unless status.to_i == 200
        # Fall back to the link's `download="filename"` value or the
        # URL path tail when Content-Disposition is absent — `<a download>`
        # is the spec hook for naming a download independently of the
        # response headers.
        forced_headers = headers.dup
        if content_disposition_header(forced_headers).to_s.empty?
          name = filename_hint.empty? ? File.basename(URI.parse(url).path.to_s) : filename_hint
          forced_headers['Content-Disposition'] = %(attachment; filename="#{name}") unless name.empty?
        end
        save_downloaded_response(url, forced_headers, body)
      end

      def pure_fragment_navigation?(url)
        return true  if url.start_with?('#')
        return false if @current_url.nil?
        target = resolve_against_current(url)
        a = URI.parse(target)
        b = URI.parse(@current_url)
        a.scheme == b.scheme && a.host == b.host && a.port == b.port && a.path == b.path && a.query == b.query && !a.fragment.nil?
      rescue URI::InvalidURIError
        false
      end

      def update_current_hash(url)
        return if @current_url.nil?
        new_url = resolve_against_current(url)
        @current_url = new_url
      end

      def set_value_with_events(handle, value)
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        # `attach_file` hands us a Pathname (or Array of Pathnames);
        # mini_racer rejects non-primitive types. Coerce to a path-list
        # form V8 can hold — the actual multipart upload happens later
        # in `build_multipart_body` during form submission.
        coerced = coerce_set_value(value)
        # For date/time-shaped inputs we need the type-specific
        # string. Probe the handle's `type` and re-format Date / Time
        # accordingly — `Date.today` → `2026-05-13` (date input) is
        # already right via to_s, but `Time` needs the input-type-
        # specific format.
        coerced = format_temporal_value(value, handle) if value.is_a?(Date) || value.is_a?(Time)
        @file_picks ||= {}
        # Capybara `attach_file` calls `Node#set` with a Pathname; some
        # callers pass a String path through directly. When the target
        # IS a file input, promote either form into the file-list path
        # so `.files` / `@file_picks` reflect the chosen file.
        coerced = [coerced.to_s] if value.is_a?(Pathname)
        if !coerced.is_a?(Array) && coerced.is_a?(String) && file_input?(handle)
          coerced = [coerced]
        end
        if coerced.is_a?(Array)
          paths = coerced.reject(&:empty?)
          @file_picks[handle] = paths
          # Expose File-list metadata to the JS side BEFORE setting the
          # value: __csimSetValue fires input + change synchronously,
          # and Redmine's onchange="addInputFiles(this)" reads
          # `inputEl.files` — if we set files after, the handler sees
          # an empty FileList and tears down the input.
          file_infos = paths.map {|p|
            stat = (File.stat(p) rescue nil)
            {
              'name'         => File.basename(p),
              'size'         => stat ? stat.size : 0,
              # Real browsers tag the File with the MIME type they
              # sniffed from the path / disk header. Uppy's image-type
              # filter rejects files whose `type` is empty, so without
              # this even a `logo.png` `attach_file` finishes uploading
              # 0 bytes through the validator and the composer's
              # `#file-uploading` flag stays set forever. Use the OS's
              # extension-based guess (matches what selenium / Chromium
              # do on these paths) and fall back to empty when the
              # extension is unknown.
              'type'         => mime_type_for_path(p),
              'lastModified' => stat ? (stat.mtime.to_f * 1000).to_i : 0
            }
          }
          @runtime.call('__csimSetFiles', handle, file_infos)
          # Mirror real browser: <input type=file>.value reflects only
          # the filename of the first chosen file (security-faked path).
          # __csimSetValue dispatches input + change synchronously.
          js_value = paths.first ? File.basename(paths.first) : ''
          @runtime.call('__csimSetValue', handle, js_value)
        else
          @runtime.call('__csimSetValue', handle, coerced)
        end
        drain_after_user_action
      end

      def coerce_set_value(v)
        case v
        when Pathname then v.to_s
        when Array    then v.map {|x| x.is_a?(Pathname) ? x.to_s : x.to_s }
        else v
        end
      end

      def format_temporal_value(v, handle)
        type = attr(handle, 'type').to_s.downcase
        case type
        when 'date'           then v.respond_to?(:strftime) ? v.strftime('%Y-%m-%d') : v.to_s
        when 'time'           then v.respond_to?(:strftime) ? v.strftime('%H:%M') : v.to_s
        when 'datetime-local' then v.respond_to?(:strftime) ? v.strftime('%Y-%m-%dT%H:%M') : v.to_s
        when 'month'          then v.respond_to?(:strftime) ? v.strftime('%Y-%m')  : v.to_s
        when 'week'           then v.respond_to?(:strftime) ? v.strftime('%Y-W%V') : v.to_s
        else
          v.is_a?(Date) ? v.strftime('%Y-%m-%d') : v.to_s
        end
      end

      def file_picks_for(handle)
        (@file_picks && @file_picks[handle]) || []
      end

      # JS-side `__HostBackedFile.text()` / `arrayBuffer()` route through
      # this to read attached file bytes on demand — ActiveStorage's
      # `DirectUpload` MD5-chunks the file via FileReader before
      # POSTing to `/rails/active_storage/direct_uploads`. Returns
      # the requested byte range as base64 so binary content
      # survives the mini_racer string boundary (same approach as
      # `__csimReadBlobBase64`).
      def read_file_pick(handle, index, start = nil, finish = nil)
        paths = file_picks_for(handle.to_i)
        path = paths && paths[index.to_i]
        return nil unless path && File.exist?(path)
        size = File.size(path)
        s = [start.to_i, 0].max
        e = finish.nil? ? size : [finish.to_i, size].min
        return Base64.strict_encode64('') if e <= s
        bytes = File.open(path, 'rb') do |f|
          f.seek(s)
          f.read(e - s)
        end
        Base64.strict_encode64(bytes || '')
      end

      def right_click(handle, keys = [], **opts)
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        init = {'bubbles' => true, 'cancelable' => true, 'button' => 2, 'which' => 3}.merge(click_event_init(handle, keys, opts))
        @runtime.call('__csimDispatchEvent', handle, 'mousedown', init)
        sleep opts[:delay].to_f if opts[:delay].to_f > 0
        @runtime.call('__csimDispatchEvent', handle, 'mouseup',     init)
        @runtime.call('__csimDispatchEvent', handle, 'contextmenu', init)
      end

      # HTML5 drag-and-drop simulation. Capybara routes `Element#drop`
      # here with a flat list of paths / Pathnames / Hashes; build a
      # DataTransfer-shaped object and dispatch dragenter / dragover /
      # drop in sequence.
      def drop(handle, args)
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        items = args.flat_map {|arg| drop_items(arg) }
        @runtime.call('__csimDropOnto', handle, items)
      end

      # Element-to-element drag. Capybara's `Element#drag_to(target,
      # delay: …)` lands here. Fires the HTML5 drag event sequence on
      # the source / target pair (mousedown → dragstart → dragenter →
      # dragover → drop → dragend) with a shared DataTransfer. Discourse
      # sidebar reorder + Avo Sortable-shaped widgets read the
      # `event.offsetY` to decide "above vs below"; without a layout
      # engine we report 0, which routes drops above the target.
      def drag_to(source_handle, target_handle, **_opts)
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(source_handle)
        ensure_alive_after_tick(target_handle)
        @runtime.call('__csimDragOnto', source_handle, target_handle)
        drain_after_user_action
      end
      def drop_items(arg)
        case arg
        when Hash
          arg.map {|type, value| {'kind' => 'string', 'type' => type.to_s, 'value' => value.to_s} }
        when ->(x) { x.respond_to?(:to_path) }
          path = arg.to_path
          [{'kind' => 'file', 'name' => File.basename(path), 'path' => path}]
        when String
          [{'kind' => 'file', 'name' => File.basename(arg), 'path' => arg}]
        else
          []
        end
      end

      def double_click(handle, keys = [], **opts)
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        # UI Events spec: two full mousedown→mouseup→click chains
        # before the trailing `dblclick`. Jspreadsheet (table-builder's
        # `.jss_worksheet`) enters edit mode on the inner mousedown.
        2.times { @runtime.call('__csimClickResolve', handle, opts) }
        init = {'bubbles' => true, 'cancelable' => true}.merge(click_event_init(handle, keys, opts))
        @runtime.call('__csimDispatchEvent', handle, 'dblclick', init)
        # Real browsers' default-action on dblclick selects the word
        # under the cursor — ProseMirror / Tiptap "paste URL over
        # selection wraps with link" tests rely on the word being
        # selected before the paste.
        @runtime.call('__csimSelectWordAt', handle)
        settle
      end

      MODIFIER_KEYS = {
        shift:    'shiftKey',
        control:  'ctrlKey',
        ctrl:     'ctrlKey',
        alt:      'altKey',
        option:   'altKey',
        meta:     'metaKey',
        command:  'metaKey'
      }.freeze
      MODIFIER_KEY_NAMES = MODIFIER_KEYS.keys.to_set.freeze
      def modifier_flags(keys)
        Array(keys).each_with_object({}) {|k, h|
          field = MODIFIER_KEYS[k.is_a?(Symbol) ? k : k.to_sym]
          h[field] = true if field
        }
      end

      # Resolve click offset against the element's CSS-declared box.
      # `opts[:offset] == :center` means "x/y is relative to the
      # element's centre" (Capybara's w3c_click_offset semantics);
      # otherwise the offset is relative to the top-left. We don't run
      # a real layout engine — `__csimElementRect` reads
      # top / left / width / height from the cascade so tests that
      # declare those values via CSS see honest coordinates.
      def click_event_init(handle, keys, opts)
        out = modifier_flags(keys)
        has_xy = opts[:x] || opts[:y]
        center = opts[:offset] == :center || !has_xy
        if has_xy || center
          rect = @runtime.call('__csimElementRect', handle)
          base_x = rect['x'].to_f + (center ? rect['width'].to_f  / 2.0 : 0.0)
          base_y = rect['y'].to_f + (center ? rect['height'].to_f / 2.0 : 0.0)
          out['clientX'] = base_x + opts[:x].to_f
          out['clientY'] = base_y + opts[:y].to_f
        end
        out
      end

      def hover(handle)
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        # Set `document._hoverElement` so `:hover` pseudo-class matches
        # resolve against this element (Redmine's gantt tooltips +
        # context-menu submenus rely on CSS `:hover`). The host fn
        # call into `__csimSetHover` does the slot update on the JS
        # side AND fires `mouseover` / `mouseenter` — keeping the
        # state-set and dispatch on the same path avoids the
        # double-eval recursion the inlined `globalThis.document.
        # _hoverElement = ...` triggered (the eval string ran inside
        # a fresh microtask that re-entered the hover listeners).
        @runtime.call('__csimSetHover', handle)
      end

      def dispatch_event(handle, type, init = {})
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        @runtime.call('__csimDispatchEvent', handle, type.to_s, init)
      end

      # Capybara's `send_keys` accepts Strings and Symbols (special
      # keys: `:enter`, `:tab`, `:backspace`, …) and Array combos
      # (modifier + key). We hand each item to JS as a tagged atom so
      # the bridge can fire proper KeyboardEvents with `key` / `code`
      # / `ctrlKey` / `metaKey` / `shiftKey` filled in — required by
      # libraries that gate behaviour on the modifier flags (Redmine's
      # jstoolbar reads `event.ctrlKey || event.metaKey` for Ctrl+B /
      # Cmd+B; quote-reply Stimulus controllers read `event.key`).
      # An Array combo is the canonical "modifier + key" pattern:
      # everything but the last entry is a modifier; the last entry
      # is the key being pressed (String char or Symbol special).
      def send_keys(handle, keys)
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        # Selenium's contract: a bare modifier symbol (`:shift`) at the
        # top level "holds" the modifier from that point on. `:null`
        # releases all modifiers. We rewrite the atom stream so each
        # following character / key carries the accumulated modifiers.
        held = []
        atoms = keys.flat_map {|k|
          case k
          when Symbol
            if k == :null
              held = []; nil
            elsif MODIFIER_KEY_NAMES.include?(k)
              held = (held + [k.to_s]).uniq; nil
            else
              held.empty? ? {'kind' => 'key',  'name'  => k.to_s}
                          : {'kind' => 'combo', 'parts' => held + [k.to_s]}
            end
          when String
            held.empty? ? {'kind' => 'text', 'value' => k}
                        : {'kind' => 'combo', 'parts' => held + [k]}
          when Array
            parts = k.map {|x| x.is_a?(Symbol) ? x.to_s : x.to_s }
            {'kind' => 'combo', 'parts' => parts}
          end
        }.compact
        # Contenteditable hosts (ProseMirror, Trix, Tiptap) reconcile
        # their view between chars; a batched `__csimSendKeys` queues
        # all `beforeinput` events on the same microtask round and PM
        # nukes the editor wrapper when its reconciler can't apply
        # them in order. Split multi-char text atoms into per-char
        # calls with a `settle` between so PM commits each transaction
        # before the next char arrives. Plain `<input>` / `<textarea>`
        # don't need this — keep the single batched call there.
        has_multichar_text = atoms.any? {|a| a['kind'] == 'text' && a['value'].to_s.length > 1 }
        if has_multichar_text && @runtime.call('__csimIsContentEditable', handle)
          per_char = atoms.flat_map {|a|
            next a unless a['kind'] == 'text' && a['value'].to_s.length > 1
            a['value'].to_s.each_char.map {|c| {'kind' => 'text', 'value' => c} }
          }
          head, *tail = per_char
          @runtime.call('__csimSendKeys', handle, [head])
          tail.each {|atom|
            tick_real_time
            @runtime.call('__csimSendKeys', handle, [atom])
            settle
          }
        else
          @runtime.call('__csimSendKeys', handle, atoms)
        end
        drain_after_user_action
      end

      def select_option(handle)
        tick_real_time
        invalidate_find_cache
        @runtime.call('__csimSelectOption', handle)
        tick_real_time
        drain_after_user_action
      end

      def unselect_option(handle)
        tick_real_time
        invalidate_find_cache
        # Single-select <select>s can't have a selection cleared per
        # HTML — Capybara surfaces this as `UnselectNotAllowed`. Ask
        # the JS side whether the option's parent select is `multiple`
        # before issuing the unselect; the answer doubles as the
        # "found the right ancestor" check.
        info = @runtime.call('__csimOptionContext', handle)
        if info.is_a?(Hash) && info['hasSelect'] && !info['multiple']
          raise Capybara::UnselectNotAllowed, 'Cannot unselect option from single select box.'
        end
        @runtime.call('__csimUnselectOption', handle)
        tick_real_time
        drain_after_user_action
      end

      # Read the form-submit pending intent set by JS-side
      # `form.submit()` / `form.requestSubmit()`. Called by user-action
      # entry points (click is the primary, but a `<select onchange="$
      # ('#form').submit()">` pattern reaches here through
      # select_option). Without this hop the intent sits on the slot
      # forever and the form never actually navigates / POSTs.
      def consume_pending_form_submit
        pending = @runtime.call('__csimTakePendingFormSubmit')
        return unless pending.is_a?(Hash) && pending['formHandle']
        submit_form_handle(pending['formHandle'].to_i, pending['submitterHandle'])
      end

      # Every user-action entry point (set / send_keys / select / unselect)
      # ends in this trio: drain any pending form submit, drain any
      # pending Element.click anchor activation, then settle the page.
      # Missing one site silently breaks the Stimulus filter pattern that
      # wires `link.click()` into input/change/keypress listeners.
      def drain_after_user_action
        consume_pending_form_submit
        consume_pending_navigation
        settle
        # Settle bails on first observable change, but Backburner-style
        # 500 ms debounces park behind a setTimeout that hasn't fired
        # yet. Drain one 600 ms window so input → debounce → parent
        # state propagation completes before the next Capybara call.
        @runtime.drain_timers(USER_ACTION_DRAIN_MS) if @timers_active && @runtime.respond_to?(:drain_timers)
      end

      # Yield on the first observable change. Each iter (a) drains
      # the chained-await/`.then` microtask queue a few rounds, (b)
      # checks the JS-side `__settleGen` counter — bumped on every
      # DOM mutation / URL change — and bails if it ticked, otherwise
      # (c) advances the virtual clock to fire rAF / setTimeout that
      # the chain is parked on. Capybara's outer polling loop drives
      # the next iter on the next find / has_? — matching real
      # browsers' "one paint = one observable moment" semantics.
      #
      # This makes a user-action settle as cheap as ~4 evals when
      # the click immediately mutates DOM, and lets `wait_for_*`
      # helpers catch transient states like "modal removed before
      # the redirect_to Visit's render rebuilds it" — exactly the
      # window real browsers paint at.
      def settle
        start_gen = @runtime.settle_gen
        prev_gen  = start_gen
        SETTLE_MAX_ITER.times do
          deliver_event_source_events
          deliver_worker_messages
          deliver_hijacked_fetches
          break if @runtime.settle_gen > start_gen
          break unless @timers_active || event_source_pending? || worker_pending? || hijack_fetch_pending?
          # ONE event-loop step replaces the old drain_microtasks(4)+drain_timers(32)
          # pair: it fires due timers, runs a per-task microtask checkpoint (so
          # chained .then / MutationObserver delivery interleave spec-correctly),
          # and runs the render phase — bailing INTERNALLY on the first settleGen
          # bump (yield_on_gen), which preserves the one-observable-boundary-per-poll
          # contract. maxMs 0 when no timer is active just flushes microtasks +
          # render for the work the deliveries above queued.
          @runtime.run_loop_step(@timers_active ? SETTLE_DRAIN_MS : 0, SETTLE_MAX_ITER_TASKS, yield_on_gen: true)
          deliver_event_source_events
          deliver_worker_messages
          deliver_hijacked_fetches
          break if @runtime.settle_gen > start_gen
          # No progress this iter (no DOM/URL change observed) — the
          # remaining timers are queued for the future; bail and let
          # Capybara's wall-clock-driven poll loop drive the next tick
          # via `tick_real_time`. SSE / Worker channels keep us in
          # the loop as long as background threads have data queued.
          break if @runtime.settle_gen == prev_gen && !@runtime.has_ready_timer? && !event_source_pending? && !worker_pending? && !hijack_fetch_pending?
          prev_gen = @runtime.settle_gen
        end
        @find_cache_dirty = true
      end

      # Read the anchor-navigation pending intent set by JS-side
      # `el.click()` (Element.prototype.click) on an `<a href>`. Avo's
      # boolean-filter / select-filter controllers respond to `input`
      # events by building the filtered URL and calling
      # `urlRedirectTarget.click()` on a hidden anchor; the click chain
      # starts from Ruby's `set_value_with_events` rather than
      # `click`, so without a parallel drain here the navigation stays
      # queued and the page never reloads.
      def consume_pending_navigation
        pending = @runtime.call('__csimTakePendingNavigation')
        return unless pending.is_a?(Hash) && pending['url']
        url    = pending['url'].to_s
        target = pending['target'].to_s
        if !target.empty? && !%w[_self _top _parent].include?(target.downcase) && @driver.respond_to?(:open_aux_window)
          @driver.open_aux_window(resolve_against_current(url, use_base: true))
        elsif pure_fragment_navigation?(url)
          update_current_hash(url)
        else
          tick_real_time
          navigate(resolve_against_current(url, use_base: true))
        end
      end

      # `<a download>` clicked synthetically (file-saver's saveAs ships
      # a freshly-created anchor through `dispatchEvent(MouseEvent
      # 'click')`). The bridge queues `{url, filename}` on
      # __csimPendingDownload during the click default-action; we drain
      # here at every tick so the file lands in `downloads_directory`
      # before Capybara's `wait_for_download` polls.
      def consume_pending_download
        pending = @runtime.call('__csimTakePendingDownload')
        return unless pending.is_a?(Hash) && pending['url']
        url = pending['url'].to_s
        filename = pending['filename'].to_s
        if url.start_with?('blob:')
          b64 = @runtime.call('__csimReadBlobBase64', url)
          return if b64.nil?
          content = Base64.decode64(b64.to_s)
          name = filename.empty? ? 'download' : filename
          dir = downloads_directory
          FileUtils.mkdir_p(dir)
          File.binwrite(File.join(dir, name), content)
        else
          download_link(resolve_against_current(url, use_base: true), filename)
        end
      end

      # `Node#submit(*)` (Capybara DSL) hits here. Find the enclosing
      # form, serialise, post.
      def submit_form(handle)
        tick_real_time
        invalidate_find_cache
        form_handle = @runtime.call('__csimAncestorForm', handle).to_i
        return if form_handle.zero?
        submit_form_handle(form_handle, nil)
      end

      def title
        tick_real_time
        @runtime.call('__csimDocumentTitle').to_s
      end

      def html
        tick_real_time
        @runtime.call('__csimDocumentHtml').to_s
      end

      def status_code      = (@last_response_status || 200)
      # Rack 3 lowercases header names; Capybara tests do `['Content-Type']`.
      def response_headers
        (@last_response_headers || {}).each_with_object({}) {|(k, v), h|
          h[k.to_s.split('-').map(&:capitalize).join('-')] = v
        }
      end
      def record_response(status, headers)
        @last_response_status  = status
        @last_response_headers = headers.to_h
      end

      def set_header(name, value)         ; @sticky_headers[name.to_s] = value.to_s ; end
      # Capybara's `current_window.resize_to(w, h)` lands here; the
      # ahoy hamburger test (mobile breakpoint at 425×694) and any
      # responsive-utility-aware test (Tailwind `m:` show / hide,
      # bootstrap `.d-md-flex`, …) depends on this surfacing through
      # the JS-side `innerWidth` / `innerHeight` so the cascade's
      # `mediaMatches` and `matchMedia()` evaluate against the test's
      # chosen viewport instead of the 1024×768 default.
      # Sticky defaults applied at `reset!`. Used by the driver to
      # carry mobile viewport / user-agent across per-test resets —
      # without these the second mobile-tagged spec sees the desktop
      # default. The user-agent also flows into `navigator.userAgent`
      # on every VM rebuild so JS-side UA branches (Discourse's
      # `viewport_based_mobile_mode = false` path) resolve correctly.
      attr_reader :default_viewport, :default_user_agent

      def default_viewport=(vp)
        @default_viewport = vp
        set_viewport(*vp) if vp
      end

      def default_user_agent=(ua)
        @default_user_agent = ua
        push_user_agent_to_js if ua
      end

      def push_user_agent_to_js
        ua = @default_user_agent or return
        return unless @runtime
        @runtime.eval("try { Object.defineProperty(navigator, 'userAgent', { value: #{ua.to_json}, configurable: true }); } catch (_) {}")
      end

      def set_viewport(w, h)
        @viewport_width  = w.to_i
        @viewport_height = h.to_i
        invalidate_find_cache
        @runtime.eval("globalThis.innerWidth = #{@viewport_width}; globalThis.innerHeight = #{@viewport_height};")
        # Recompute the cascade `@media` rules against the new
        # viewport so visibility checks (Capybara `visible?`,
        # `getComputedStyle().display`) re-reflect mobile-breakpoint
        # `display: none` / `display: block` flips. Without this the
        # cascade keeps the pre-resize hide-rule set.
        @runtime.call('__csimRebuildCascade') if @document_handle.to_i > 0
        # Fire `change` events on every live MediaQueryList whose
        # match state flipped, so libraries that hold `matchMedia(...)`
        # listeners (Discourse's `TrackedMediaQuery` powering the
        # viewport-based mobile/desktop class swap) reactively
        # re-render. The JS-side function iterates `_activeQueries`
        # and dispatches only on transitions — cheap no-op when no
        # query is open.
        @runtime.call('__csimViewportChanged') if @document_handle.to_i > 0
        # Re-fire a `resize` event so libraries that re-layout on
        # resize (responsive nav, sidebar collapse) see the new size.
        @runtime.eval("try { (globalThis.dispatchEvent || function(){})(new Event('resize')); } catch (_) {}")
        nil
      end
      def viewport_width                  ; @viewport_width  || 1024 ; end
      def viewport_height                 ; @viewport_height || 768  ; end
      # Capybara-initiated `page.go_back` runs from Ruby, not inside a
      # JS call, so it's safe to rebuild the Context synchronously. The
      # `force:` flag bypasses the deferral that `history_go` uses to
      # avoid terminating the running JS context.
      def go_back        ; history_go(-1, force: true) ; end
      def go_forward     ; history_go(+1, force: true) ; end

      # Move through the history stack by `delta`. Per HTML spec, a
      # same-document traversal (within a chain of pushState entries
      # rooted at a single navigation) updates `location` and fires
      # `popstate` with the entry's state — no full reload. A cross-
      # document traversal replays the entry (full navigate / re-POST).
      def history_go(delta, force: false)
        delta = delta.to_i
        return if delta == 0
        target = @history_idx + delta
        return if target < 0 || target >= @history.size
        if same_document_traversal?(@history_idx, target)
          # Pure pushState traversal — no VM rebuild, safe to run
          # inline; the popstate dispatch happens within the current
          # call's JS context.
          @history_idx = target
          entry = @history[target]
          @current_url = entry[:url]
          @runtime.call('__csimUpdateLocation', @current_url)
          @runtime.call('__csimDispatchPopState', entry[:state])
        elsif force
          # Ruby-driven (`page.go_back`) — no live JS call to interrupt,
          # safe to rebuild the Context synchronously.
          perform_history_traverse(target)
        else
          # JS-driven (`history.back()` from a page handler): replaying
          # the history entry synchronously would call `rebuild_ctx`
          # on the still-executing Context and terminate the current
          # call with `ScriptTerminatedError` (mini_racer's
          # `Context#stop` raises on the eval thread). Stash the intent
          # and drain after the call returns — mirrors
          # `location_assign` / `location_reload`.
          @pending_history_traverse = target
        end
      end

      def consume_pending_history_traverse
        return unless (target = @pending_history_traverse)
        @pending_history_traverse = nil
        perform_history_traverse(target)
      end

      private def perform_history_traverse(target)
        @history_idx = target
        replay_history_entry(@history[target])
      end

      # Same-document = every entry between `from` and `to` (inclusive)
      # is a `:push_state` entry (or the boundary just changed state on
      # the current URL). A `:visit` entry between them means we'd
      # cross a real navigation, which needs a fresh document.
      def same_document_traversal?(from, to)
        lo, hi = [from, to].sort
        ((lo + 1)..hi).all? {|i| @history[i] && @history[i][:kind] == :push_state }
      end

      def record_history(entry)
        # Discard any forward-history tail (a real browser drops the
        # redo stack the moment you navigate after a `go_back`).
        @history = @history[0..@history_idx] if @history_idx + 1 < @history.size
        @history << entry.merge(kind: entry[:kind] || :visit)
        @history_idx = @history.size - 1
      end
      def replay_history_entry(entry)
        return unless entry
        if entry[:method] == :post
          navigate_post(entry[:url], entry[:body], entry[:content_type], from_history: true)
        else
          navigate(entry[:url], from_history: true)
        end
      end
      def active_element_handle
        tick_real_time
        h = @runtime.call('__csimActiveElement').to_i
        h.zero? ? nil : h
      end
      # Session-level keystroke. Tab / shift-tab cycle focus; everything
      # else is routed to the currently focused element (if any) as a
      # plain keydown/keyup pair.
      def send_session_keys(keys)
        # Walk the key list with running modifier state so a Selenium-
        # style `(:shift, :enter)` invocation reaches `Browser#send_keys`
        # as one combo atom (shift held over enter), while independent
        # non-modifier keys stay separate calls — each one settles
        # between dispatches so a dropdown highlight (Avo Tags input's
        # arrow navigation) commits before the next key fires. Tab /
        # backtab are focus-advance, dispatched out of band.
        held = []
        Array(keys).each do |k|
          sym = k.is_a?(Symbol) ? k : (k.respond_to?(:to_sym) ? k.to_sym : nil)
          if sym == :tab || sym == :backtab
            @runtime.call('__csimAdvanceFocus', sym == :backtab)
          elsif sym && MODIFIER_KEY_NAMES.include?(sym)
            held << sym
          else
            handle = active_element_handle
            handle = @document_handle if handle.nil? || handle.zero?
            atom = held.empty? ? k : (held + [k])
            send_keys(handle, [atom])
          end
        end
      end

      def send_session_key(key) = send_session_keys([key])
      attr_reader :trace, :pending_trace, :trace_mode

      TRACE_MODES = {'off' => :off, 'on-failure' => :on_failure, 'full' => :full}.freeze
      private_constant :TRACE_MODES

      def parse_trace_mode(raw)
        return :on_failure if raw.nil? || raw.empty?
        TRACE_MODES[raw] || raise(ArgumentError, "CSIM_TRACE must be one of #{TRACE_MODES.keys.join(', ')}; got #{raw.inspect}")
      end

      def start_trace(metadata = {})
        @trace = Trace.new(metadata: metadata)
        @runtime.call('__csimSetTraceActive', true)
      end

      # Persist `trace` (defaults to live or pending) to `path` and
      # return the path. Doesn't clear — `clear_trace!` is the explicit
      # follow-up so a caller can inspect after writing if it wants.
      def finish_trace_to(path, trace = (@trace || @pending_trace))
        return nil unless trace
        trace.write_json(path)
      end

      def clear_trace!
        @trace         = nil
        @pending_trace = nil
        @runtime.call('__csimSetTraceActive', false)
      end

      # Wraps a driver action so the trace records description, urls,
      # console / network activity, and (on action error / full mode)
      # a post-action DOM snapshot. Re-entrant: nested recorded actions
      # (label-click → click, session send_keys → send_keys) let the
      # outer step own the boundary and the inner just yields.
      #
      # `description` is a String or Proc — Procs are lazy-evaluated
      # only when a step is actually being recorded, so the off-path
      # doesn't pay `describe_node_handle`'s V8 round-trip.
      def record_action(kind, description)
        # Off-mode: no autostart, only proceed if a trace was started
        # explicitly via `driver.start_tracing`. Hot path for users
        # who set CSIM_TRACE=off.
        return yield if @trace.nil? && @trace_mode == :off
        if @trace.nil?
          @trace = Trace.new(metadata: {auto_started_at: Time.now.utc.iso8601(3)})
          @runtime.call('__csimSetTraceActive', true)
        end
        return yield if @recording_action
        @recording_action = true
        desc = description.is_a?(Proc) ? description.call : description
        @trace.begin_step(kind, description: desc, url_before: @current_url)
        error = nil
        begin
          yield
        rescue => e
          error = {class: e.class.name, message: e.message}
          raise
        ensure
          # `full` mode serializes the document after every action; the
          # default `on_failure` mode only snapshots when an action
          # errored. The V8 round-trip + DOM serialize is the
          # expensive part of trace recording, so skipping it on the
          # happy path is the whole point of the default.
          dom = (error || @trace_mode == :full) ? html : nil
          @trace.finish_step(url_after: @current_url, dom_after: dom, error: error)
          @recording_action = false
        end
      end

      def log_console(severity, message)
        return unless @trace
        @trace.log_console(severity, annotate_console_message(severity, message))
      end

      # info/debug/log lines almost never carry stack traces — keep them
      # out of the regex pass so per-call cost stays at the severity gate.
      ANNOTATABLE_SEVERITIES = %w[error warning warn].freeze
      def annotate_console_message(severity, message)
        return message unless ANNOTATABLE_SEVERITIES.include?(severity.to_s)
        return message unless message.is_a?(String) && message.include?('://')
        stack_resolver.annotate(message)
      end

      def stack_resolver
        @stack_resolver ||= StackResolver.new(self)
      end

      def log_network(method, url, status) = @trace&.log_network(method, url, status)

      # `tag#id.class` short description of the handle, for trace
      # `description` fields. One V8 round-trip; only paid when a step
      # is actively being recorded (`record_action` lazy-evaluates the
      # description Proc).
      def describe_node_handle(handle)
        return "handle=#{handle}" if handle.nil? || handle.zero?
        info = @runtime.call('__csimDescribeNode', handle)
        return "handle=#{handle}" unless info.is_a?(Hash)
        s = info['tag'].to_s
        s += "##{info['id']}"  unless info['id'].to_s.empty?
        s += ".#{info['cls']}" unless info['cls'].to_s.empty?
        s
      end
      def evaluate_script(code, args = [])
        # Drain timers first so ready handlers (jQuery `$(handler)`,
        # framework `DOMContentLoaded` listeners) run before the
        # user's script. Without this, `execute_script` can fire
        # *before* the page's own setup code that the test expects
        # to be active.
        tick_real_time
        invalidate_find_cache
        result = @runtime.call('__csimEvalScript', code.to_s, marshal_args(args || []))
        drain_pending_navigation
        result
      end

      # Fire-and-forget variant: runs the script but never returns
      # its value to Ruby. Lets execute_script handle scripts whose
      # return is a complex JS object (jQuery chainable, DOM tree,
      # …) that mini_racer's value filter would recurse into.
      def execute_script(code, args = [])
        tick_real_time
        invalidate_find_cache
        @runtime.call('__csimExecScript', code.to_s, marshal_args(args || []))
        drain_pending_navigation
        nil
      end

      # CDP-ish shim: override navigator.geolocation (like CDP's
      # `Emulation.setGeolocationOverride`). State is Ruby-backed on
      # `@geolocation`; the JS geolocation object reads it on every call via
      # the `__csimGeolocationState` host fn, so it survives the per-call VM
      # rebuilds (the same model web storage uses).
      #
      #   set_geolocation(latitude: 35.6, longitude: 139.7)
      #   set_geolocation(latitude: 1, longitude: 2, accuracy: 5, altitude: 10)
      #   set_geolocation(denied: true)  # report PERMISSION_DENIED
      #   set_geolocation                # clear -> report POSITION_UNAVAILABLE
      def set_geolocation(latitude: nil, longitude: nil, accuracy: 10, denied: false, **rest)
        @geolocation =
          if denied
            {'denied' => true}
          elsif latitude.nil? || longitude.nil?
            nil
          else
            {'coords' => {'latitude' => latitude, 'longitude' => longitude, 'accuracy' => accuracy}.merge(rest.transform_keys(&:to_s))}
          end

        # Re-deliver to any active watchPosition watchers, mirroring a real
        # browser firing the watch again when the location updates. The JS
        # side reads the fresh @geolocation via the host fn.
        execute_script('if (typeof globalThis.__csimGeoRefireWatches === "function") globalThis.__csimGeoRefireWatches();')
        nil
      end

      # Backs the `__csimGeolocationState` host fn. Returns the configured
      # geolocation override as a JSON string (or 'null' when none is set),
      # which the JS geolocation object reads on every getCurrentPosition /
      # watchPosition call.
      def geolocation_state_json
        JSON.generate(@geolocation)
      end

      # Capybara passes Node instances directly as script args
      # (`session.evaluate_script('arguments[0].click()', some_node)`).
      # mini_racer can't marshal a Ruby Node, so wrap as a sentinel
      # the JS side recognises and rehydrates via the handle registry.
      def marshal_args(args)
        args.map {|a|
          case a
          when Capybara::Simulated::Node then {'__elementHandle' => a.handle_id}
          when Array                       then marshal_args(a)
          when Hash                        then a.transform_values {|v| marshal_args([v]).first }
          else a
          end
        }
      end
      def evaluate_async_script(code, args = [])
        tick_real_time
        invalidate_find_cache
        @runtime.call('__evalAsyncScript', code.to_s, marshal_args(args || []))
        # Pump virtual time so any setTimeout-driven completion lands.
        # Capybara's polling can't help here — we're inside one session
        # call, not a retry loop.
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) +
                   Capybara.default_max_wait_time.to_f
        loop do
          result = @runtime.call('__pollAsyncResult')
          return result['value'] if result.is_a?(Hash) && result.key?('value')
          break if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
          sleep 0.01
          tick_real_time
        end
        nil
      end

      def current_path
        tick_real_time
        return '' if @current_url.nil? || @current_url.empty?
        URI.parse(@current_url).path
      rescue URI::InvalidURIError
        ''
      end

      # Capybara polls find / has_? via `synchronize` while
      # `Driver#wait?` is true. We stay true while there's any scheduled
      # timer (`@timers_active` is flipped by the JS bridge's
      # `__setTimersActive` callback), plus a sticky grace window after
      # the last timer fires so a `setTimeout` firing mid-loop doesn't
      # drop us off polling before Capybara's own retry deadline.
      #
      # Settle-gen idle gate: a recurring `setInterval` from a framework
      # runloop (Ember / Glimmer) keeps `@timers_active` true forever
      # even when nothing observable is changing. Without a second
      # signal, Capybara waits the full `default_max_wait_time` on every
      # `has_css?` / `has_no_css?` that's destined to fail — which
      # Discourse's `CapybaraTimeoutExtension` reports as a "slow
      # spec" failure. Track `@runtime.settle_gen` across polls: when
      # it hasn't bumped for `IDLE_SETTLE_POLLS` calls, drop polling
      # even though timers are scheduled. `settle_gen` already bumps
      # on every DOM mutation / URL change (see __settleGen wiring),
      # so this only short-circuits genuinely idle loops.
      def polling?
        # Background-thread work (workers, EventSource, MessageBus
        # long-poll) keeps the settle loop alive even when settle_gen
        # is otherwise idle.
        return true if worker_pending? || event_source_pending? || hijack_fetch_pending?
        if @timers_active
          gen = @runtime.settle_gen
          if @last_polled_gen.nil? || gen != @last_polled_gen
            @last_polled_gen = gen
            @idle_settle_polls = 0
            @polling_grace = POLLING_GRACE_POLLS
            return true
          end
          @idle_settle_polls += 1
          return true if @idle_settle_polls < IDLE_SETTLE_POLLS
          # Treat as idle for this poll; if a fresh timer fires later
          # the next poll's settle_gen check will resume polling.
          false
        elsif @polling_grace && @polling_grace > 0
          @polling_grace -= 1
          true
        else
          false
        end
      end

      # Advance the virtual JS clock and fire timers that came due.
      # When `step_ms` is omitted, advance by the wall-clock ms
      # elapsed since the last tick (clamped to MAX_TICK_MS) — this
      # is the wall-sync model: Capybara polls every retry_interval
      # ms of wall, each find here advances virtual by the same
      # amount, and a 200 ms debounce naturally fires after 20 polls
      # the way a real browser would observe it. Explicit `step_ms`
      # is used by `SleepHook#advance_virtual_clock_ms` (from
      # `Kernel#sleep`) and by `Playwright::Page#wait_for_timeout`
      # to step a precise virtual duration.
      def tick_real_time(step_ms: nil)
        return unless @timers_active || worker_pending? || event_source_pending? || hijack_fetch_pending?
        # Re-entrancy guard. Capybara's `Result#each` triggers nested
        # finds (visible? per element); the outermost tick has already
        # advanced the clock, the inner calls would only re-drain
        # already-fired timers.
        return if @ticking
        @ticking = true
        begin
          now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          effective_step = step_ms || ((now - (@last_tick_ts || now)) * 1000).to_i.clamp(0, MAX_TICK_MS)
          @last_tick_ts = now
          if @timers_active && effective_step > 0
            r = @runtime.run_loop_step(effective_step)
            # `dirtied` (settleGen changed) catches a render-phase rAF / microtask-
            # delivered MutationObserver that mutated the DOM without firing a timer
            # (fired == 0) — a fired-count-only test would leave a stale find cache.
            @find_cache_dirty = true if r['dirtied'] || r['fired'].to_i > 0
          end
          # Pull any pending Worker / EventSource messages into JS
          # state. Without this, `evaluate_script` after kicking off
          # a worker round-trip would see stale state — the inbox
          # outbox only drains during `settle`, which doesn't run
          # for direct `execute_script` / `evaluate_script` calls.
          @find_cache_dirty = true if deliver_worker_messages > 0
          @find_cache_dirty = true if deliver_event_source_events > 0
          @find_cache_dirty = true if deliver_hijacked_fetches > 0
        ensure
          @ticking = false
        end
        # Drain navigation intents queued by JS-side handlers that fired
        # during the drain (e.g. `setTimeout(() => location.pathname = X)`).
        # Outside the @ticking guard so the navigate's rebuild_ctx is
        # well-clear of the V8 call we just made.
        drain_pending_navigation
        # Same shape for `form.submit()` queued by a timer callback —
        # Forem's comment-edit form has an `onsubmit` handler that
        # `preventDefault`s, polls for the CSRF meta tag inside
        # `setInterval(…, 1)`, then calls `form.submit()` once the
        # meta is present. The click that originally fired the submit
        # event has already returned by the time the interval triggers,
        # so without this drain the intent sits on the slot forever
        # and the form never posts.
        consume_pending_form_submit
        # And for `<a download>` clicks (Avo's action-download chain
        # goes via file-saver's `saveAs` → synthetic dispatchEvent
        # on a freshly-created anchor with `download` + blob URL).
        consume_pending_download
      end

      def advance_virtual_clock_ms(ms)
        ms = ms.to_i
        tick_real_time(step_ms: ms) if ms > 0
      end

      # Re-sync the Ruby-side timer mirror with a freshly-rebuilt JS
      # context. Clear `@timers_active` and the `@polling_grace` grace
      # window so the previous page's pending-timer state doesn't leak
      # into the next test, leaving `Driver#wait?` true and dragging
      # every failing matcher through the full `default_max_wait_time`
      # retry loop.
      def reset_timer_state
        @last_tick_ts      = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @timers_active     = false
        @polling_grace     = nil
        @last_polled_gen   = nil
        @idle_settle_polls = 0
        @context_gen      += 1
      end

      attr_reader :context_gen

      # Pulls the serialised form-state out of JS, encodes it, and
      # drives the Rack app via `navigate` (for GET) or a POST.
      def submit_form_handle(form_handle, submitter_handle)
        invalidate_find_cache
        spec = @runtime.call('__csimFormSerialize', form_handle, submitter_handle || 0)
        return unless spec.is_a?(Hash)
        action  = spec['action'].to_s
        method  = spec['method'].to_s.upcase
        method  = 'GET' if method.empty?
        fields  = (spec['fields'] || []).map {|pair| [pair[0].to_s, pair[1].to_s] }
        file_inputs = spec['fileInputs'] || []
        enctype = spec['enctype'].to_s
        multipart = enctype.start_with?('multipart/form-data')
        content_type = nil
        body =
          if multipart
            built = build_multipart_body(fields, file_inputs)
            content_type = built[:content_type]
            built[:body]
          else
            # Non-multipart: file inputs contribute the filename only.
            file_inputs.each do |fi|
              picks = @file_picks && @file_picks[fi['handle'].to_i] || []
              fields << [fi['name'].to_s, picks.first ? File.basename(picks.first) : '']
            end
            URI.encode_www_form(fields)
          end
        action_url = action.empty? ? (@current_url || @default_host) : resolve_against_current(action)
        if method == 'GET'
          uri = URI.parse(action_url)
          uri.query = body unless body.empty?
          navigate(uri.to_s)
        else
          navigate_post(action_url, body, content_type || enctype)
        end
      end

      def build_multipart_body(fields, file_inputs)
        boundary = "csim-#{SecureRandom.hex(8)}"
        body     = String.new.force_encoding(Encoding::ASCII_8BIT)
        fields.each do |name, value|
          append_multipart_part(body, boundary, name, value.to_s)
        end
        file_inputs.each do |fi|
          picks = @file_picks && @file_picks[fi['handle'].to_i] || []
          if picks.empty?
            append_multipart_part(body, boundary, fi['name'].to_s, '', filename: '')
          else
            picks.each do |path|
              append_multipart_part(body, boundary, fi['name'].to_s, File.binread(path),
                                    filename:     File.basename(path),
                                    content_type: Rack::Mime.mime_type(File.extname(path)))
            end
          end
        end
        body << "--#{boundary}--\r\n"
        {content_type: "multipart/form-data; boundary=#{boundary}", body: body}
      end

      def append_multipart_part(body, boundary, name, content, filename: nil, content_type: nil)
        body << "--#{boundary}\r\n"
        disposition = %[form-data; name="#{name}"]
        disposition += %[; filename="#{filename}"] if filename
        body << "Content-Disposition: #{disposition}\r\n"
        body << "Content-Type: #{content_type}\r\n" if content_type
        body << "\r\n"
        body << content.to_s.b
        body << "\r\n"
      end

      def navigate_post(url, body, content_type, depth: 0, from_history: false)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
        record_history({method: :post, url: url, body: body, content_type: content_type}) unless from_history || depth > 0
        env = Rack::MockRequest.env_for(url, method: 'POST', input: body)
        env['CONTENT_TYPE']   = content_type.empty? ? 'application/x-www-form-urlencoded' : content_type
        env['CONTENT_LENGTH'] = body.bytesize.to_s
        apply_default_request_env(env, referer: @current_url)
        status, headers, resp_body = dispatch_rack_or_http(url, env, method: 'POST', body: body)
        merge_set_cookie(headers)
        if (loc = redirect_location(status, headers))
          next_url = resolve_against_current(loc)
          resp_body.close if resp_body.respond_to?(:close)
          # HTTP semantics: 301/302/303 → method becomes GET; 307/308
          # require the method (and body) to be preserved.
          if [307, 308].include?(status)
            return navigate_post(next_url, body, content_type, depth: depth + 1)
          else
            return navigate(next_url, depth: depth + 1)
          end
        end
        if download_response?(headers)
          save_downloaded_response(url, headers, resp_body)
          return
        end
        @current_url = url
        record_response(status, headers)
        html         = read_rack_body(resp_body)
        # Same rebuild-on-full-load contract as `navigate`. POST
        # responses (form submissions that don't redirect, AJAX-less
        # data-remote replies) replace the page; we follow real-browser
        # semantics and bring up a fresh VM rather than papering over
        # the previous one's state.
        boot_response_into_ctx(html)
      end

      def reset!
        @cookies.clear
        @local_storage.clear
        @session_storage.clear
        @sticky_headers.clear
        # The driver-side resize buffer has to clear too — without
        # this the previous test's `driver.resize(425, …)` leaks into
        # the next test's default viewport and any cascade rule that
        # gates on `(min-width: …)` reports the wrong answer for the
        # whole new test (Forem's comment-actions dropdown is
        # mobile-collapsed-by-default). The exception is the
        # `default_viewport` channel — drivers built for a mobile
        # session (Discourse's `playwright_mobile_chrome`) need to
        # stay mobile across resets, not snap back to desktop on the
        # next mobile-tagged test.
        if @default_viewport
          @viewport_width  = @default_viewport[0]
          @viewport_height = @default_viewport[1]
        else
          @viewport_width  = nil
          @viewport_height = nil
        end
        @current_url     = nil
        @document_handle = 0
        @history.clear
        @history_idx     = -1
        @file_picks      = {} if @file_picks
        # Hand the live trace off to `@pending_trace` so an after-hook
        # running after `reset_session!` (Capybara's per-test teardown
        # order) still finds it. Anything stuck in `@pending_trace`
        # from a prior test is dropped — better than fusing two
        # tests' actions into one record.
        @pending_trace    = @trace
        @trace            = nil
        @recording_action = false
        # Kill any open SSE reader threads — the new VM has no JS-side
        # EventSource instances to dispatch into, and the old handles
        # would collide on the fresh handle counter the bridge starts
        # from after `reset_page`. Same shape for worker threads.
        reset_event_sources
        reset_hijacked_fetches
        reset_workers
        @blob_registry_lock.synchronize { @blob_registry.clear }
        # Drop volatile entries from the class-level HTTP asset cache
        # so test-local DB state (TranslationOverride, etc.) reaches
        # the app on subsequent visits. Fingerprinted assets
        # (`Cache-Control: immutable`) survive: their URLs are content-
        # addressable so a stale entry can't shadow a later test.
        @@asset_cache.clear_volatile if @@asset_cache.respond_to?(:clear_volatile)
        @runtime.reset_page
        # Per-visit ctx rebuild drops the JS-side trace-active flag,
        # so re-flip it if we're carrying a pending trace into the
        # next visit.
        @runtime.call('__csimSetTraceActive', false)
        reset_timer_state
        invalidate_find_cache
      end

      # ── Host-fn callbacks invoked by bridge.js ──────────────────

      def rack_fetch_body(url)
        result = rack_fetch('GET', url, '', {}, 'follow')
        return nil unless result && result['status'].to_i < 400
        result['body'].to_s
      end

      # Native ESM entry point. QuickJS uses its `vm.module_loader`;
      # V8 uses `Context#compile_module` + `Module#instantiate` /
      # `#evaluate` + `Context#dynamic_import_resolver=`. Both runtimes
      # expose `eval_esm_module`.
      def eval_esm_module(url, src = nil)
        @runtime.eval_esm_module(url, src)
      end

      # ── EventSource (SSE) ──────────────────────────────────────────
      #
      # Mastodon (and any app using Server-Sent Events) opens an
      # `EventSource` to a streaming endpoint and expects pushed events
      # to fire `message`/typed listeners on the live instance. Our
      # implementation:
      #   1. JS-side `new EventSource(url)` calls `__csim_eventSourceOpen`
      #      which returns an integer handle and spawns a Ruby thread.
      #   2. The thread holds a chunked-read HTTP connection open and
      #      parses the SSE event-stream wire format, pushing each
      #      `{id:, type:, data:, lastEventId:}` (or `{type: '__open'}`
      #      / `{type: '__error', message:}` sentinel) onto a
      #      thread-safe queue.
      #   3. Settle's drain loop calls `deliver_event_source_events`
      #      which polls the queue and hands the batch to
      #      `__csim_deliverEventSourceEvents` for dispatch.
      # mini_racer / quickjs.rb VMs are single-threaded; only the main
      # thread ever enters the VM. Background threads only touch the
      # Queue. `reset!` and per-visit context rebuilds kill all open
      # threads — the new VM gets a fresh handle space.
      def event_source_open(url)
        id     = (@event_source_seq += 1)
        queue  = @event_source_queue
        thread = Thread.new do
          Thread.current.report_on_exception = false
          run_event_source_reader(id, url.to_s, queue)
        end
        @event_source_threads[id] = thread
        id
      end

      def event_source_close(id)
        thread = @event_source_threads.delete(id.to_i)
        thread&.kill
        nil
      end

      def event_source_poll
        drain_queue(@event_source_queue)
      end

      def event_source_pending? = !@event_source_queue.empty?

      # Drain any queued events into the VM. Cheap when no SSE
      # connection is active (no threads → no queue items → empty
      # return). Returns the number of events delivered so settle can
      # tell whether progress was made.
      def deliver_event_source_events
        return 0 if @event_source_threads.empty? && @event_source_queue.empty?
        events = event_source_poll
        return 0 if events.empty?
        @runtime.call('__csim_deliverEventSourceEvents', events)
        events.size
      end

      # Background-thread entry point. Resolves the URL (relative
      # paths against current page), opens a raw TCP / TLS socket,
      # speaks just enough HTTP/1.1 to make the request, and reads
      # chunked SSE bodies. Net::HTTP would be more natural but
      # WebMock's `disable_net_connect!(allow_localhost: true)`
      # routes Net::HTTP through an adapter that buffers chunked
      # responses until the body completes — which never happens on a
      # long-lived event stream. TCPSocket is below WebMock's hook
      # surface so this stays a real network read.
      private def run_event_source_reader(id, url, queue)
        target = resolve_against_current(url)
        uri    = URI(target)
        unless uri.is_a?(URI::HTTP) || uri.is_a?(URI::HTTPS)
          queue << {id: id, type: '__error', message: "unsupported scheme: #{uri.scheme.inspect}"}
          return
        end
        socket = open_event_source_socket(uri)
        send_event_source_request(socket, uri)
        status_line = socket.gets
        unless status_line
          queue << {id: id, type: '__error', message: 'empty response'}
          return
        end
        code = status_line[%r{HTTP/[\d.]+\s+(\d+)}, 1].to_i
        chunked = false
        while (line = socket.gets) && line.strip != ''
          chunked = true if line =~ /\Atransfer-encoding:\s*chunked/i
        end
        if code >= 400
          queue << {id: id, type: '__error', message: "HTTP #{code}"}
          return
        end
        queue << {id: id, type: '__open'}
        read_event_source_body(socket, id, queue, chunked: chunked)
      rescue EOFError, Errno::ECONNRESET
        # Server closed mid-stream — normal lifecycle, not an error
        # worth surfacing.
      rescue StandardError => e
        queue << {id: id, type: '__error', message: "#{e.class}: #{e.message}"}
      ensure
        begin
          socket.close if socket && !socket.closed?
        rescue StandardError
          # socket might have been closed concurrently (reset! killed
          # the thread); the leak is harmless.
        end
      end

      private def open_event_source_socket(uri)
        if uri.is_a?(URI::HTTPS)
          require 'openssl'
          tcp  = TCPSocket.new(uri.host, uri.port)
          ctx  = OpenSSL::SSL::SSLContext.new
          ssl  = OpenSSL::SSL::SSLSocket.new(tcp, ctx)
          ssl.sync_close = true
          ssl.hostname   = uri.host
          ssl.connect
          ssl
        else
          TCPSocket.new(uri.host, uri.port)
        end
      end

      private def send_event_source_request(socket, uri)
        host_header = uri.port == uri.default_port ? uri.host : "#{uri.host}:#{uri.port}"
        lines = [
          "GET #{uri.request_uri} HTTP/1.1",
          "Host: #{host_header}",
          'Accept: text/event-stream',
          'Accept-Encoding: identity',
          'Cache-Control: no-store',
          'Connection: keep-alive'
        ]
        # Forward the host-cookie jar so the streaming server can
        # authenticate the user the same way the browser would. The
        # jar is a flat name=value map (no per-host scoping); reuse
        # the canonical `document_cookie` serialiser the Rack path
        # uses, so we don't drift if its format changes.
        cookies = document_cookie
        lines << "Cookie: #{cookies}" unless cookies.empty?
        socket.write(lines.join("\r\n") << "\r\n\r\n")
        socket.flush
      end

      private def read_event_source_body(socket, id, queue, chunked:)
        buffer = String.new
        loop do
          if chunked
            size_line = socket.gets
            break unless size_line
            size = size_line.strip.to_i(16)
            break if size.zero?
            buffer << socket.read(size).to_s
            socket.read(2)  # trailing CRLF
          else
            buffer << socket.readpartial(4096)
          end
          while (idx = buffer.index("\n\n") || buffer.index("\r\n\r\n"))
            sep_len   = buffer[idx, 4] == "\r\n\r\n" ? 4 : 2
            raw_event = buffer[0...idx]
            buffer    = buffer[(idx + sep_len)..]
            event     = parse_sse_event(raw_event)
            queue << {id: id, **event} if event
          end
        end
      end

      private def parse_sse_event(block)
        type = nil
        data = []
        last_id = nil
        block.each_line do |line|
          line = line.chomp
          next if line.empty? || line.start_with?(':')
          if (idx = line.index(':'))
            field = line[0...idx]
            value = line[(idx + 1)..]
            value = value[1..] if value.start_with?(' ')
          else
            field = line
            value = ''
          end
          case field
          when 'event' then type = value
          when 'data'  then data << value
          when 'id'    then last_id = value
          end
        end
        return nil if data.empty? && type.nil?
        {type: type || 'message', data: data.join("\n"), lastEventId: last_id}
      end

      def reset_event_sources
        @event_source_threads.each_value(&:kill)
        @event_source_threads.clear
        @event_source_queue.clear
      end

      # ── Hijack-aware async XHR ─────────────────────────────────────
      #
      # Real browsers' long-poll keeps the request socket open across
      # the entire user-interactive session, so a server-side
      # `MessageBus.publish` (or any other middleware writing through
      # `rack.hijack`) lands on the open connection and the client
      # gets the response when the server is ready. Our default
      # `__rackFetch` is purely sync — the middleware's hijack path
      # never engaged, so MessageBus's `subscribe(channel, -1)` +
      # `__status` reset chain dropped any publish that landed
      # between two scheduled polls.
      #
      # `rack_fetch_async` runs the Rack call with a `rack.hijack`
      # lambda installed. The lambda is invoked iff the middleware
      # actually hijacks; we detect that and spawn a background
      # thread to read from the pipe until the middleware closes its
      # end (a publish landed via `notify_clients`, or
      # `cleanup_timer` fired the empty-`[]` close after
      # `long_polling_interval`). Non-hijacking responses queue
      # immediately on the same thread — no thread spawn, no
      # backpressure beyond the existing sync `__rackFetch` cost.
      #
      # The contract is generic: any middleware that follows the
      # Rack hijack protocol works, not just `message_bus`. JS-side
      # XHR's async path routes every request here; sync XHRs
      # (`xhr.open(_, _, false)`, deprecated) stay on `__rackFetch`
      # because the hijack contract can't satisfy a synchronous XHR
      # response anyway.
      # Returns either a response hash (immediate — middleware didn't
      # hijack) or a `{'handle' => N}` token (deferred — middleware
      # hijacked the connection and a background thread is reading
      # the pipe). The JS-side XHR checks the return shape to pick
      # between inline processing and waiting for `__csim_
      # deliverHijackedFetches`.
      def rack_fetch_async(method, url, body, headers_json)
        headers = begin
          JSON.parse(headers_json.to_s)
        rescue JSON::ParserError
          {}
        end
        # `rack_fetch` already handles redirects, cookie merge, the
        # asset cache shortcut, and download detection — keep async
        # XHRs on that single source of truth. The new behaviour is
        # the hijack hook for long-poll-shaped requests: install
        # `rack.hijack` so the middleware can hold the connection
        # open until something publishes through it.
        #
        # We can't unconditionally install the hijack env keys: some
        # downstream Discourse middleware paths take a different
        # streaming branch when `rack.hijack?` is truthy (even
        # without ever invoking the lambda) and the response then
        # re-renders the page in a slightly different order, racing
        # subsequent Capybara `find`s into StaleElement. Restrict
        # the hook to URLs that look like the long-poll endpoints
        # we actually need it for (`/message-bus/{id}/poll` today;
        # extend as new patterns surface).
        read_io = nil
        env_extras =
          if HIJACK_AWARE_URL_PATTERNS.any? {|re| re.match?(url.to_s) }
            {
              'rack.hijack?' => true,
              'rack.hijack'  => lambda {
                read_io, write_io = IO.pipe
                write_io
              }
            }
          end
        resp = rack_fetch(method, url, body, headers, 'follow', env_extras: env_extras)
        return resp || {'status' => 0, 'headers' => {}, 'body' => ''} unless read_io
        id = (@hijack_fetch_seq += 1)
        @hijack_fetch_threads[id] = Thread.new do
          Thread.current.report_on_exception = false
          run_hijacked_pipe_read(id, read_io, @hijack_fetch_queue)
        end
        {'handle' => id}
      end

      # URLs whose middleware needs `rack.hijack` to hold the
      # connection open. Only enable hijack for these so the
      # `rack.hijack?` capability check doesn't perturb the response
      # path on unrelated requests.
      HIJACK_AWARE_URL_PATTERNS = [
        %r{/message-bus/[^/]+/poll(?:\?|$)}
      ].freeze
      private_constant :HIJACK_AWARE_URL_PATTERNS

      def rack_fetch_async_abort(id)
        thread = @hijack_fetch_threads.delete(id.to_i)
        thread&.kill
        nil
      end

      def hijack_fetch_pending? = !@hijack_fetch_threads.empty? || !@hijack_fetch_queue.empty?

      def deliver_hijacked_fetches
        return 0 if @hijack_fetch_threads.empty? && @hijack_fetch_queue.empty?
        responses = drain_queue(@hijack_fetch_queue)
        return 0 if responses.empty?
        @runtime.call('__csim_deliverHijackedFetches', responses)
        responses.size
      end

      def reset_hijacked_fetches
        @hijack_fetch_threads.each_value(&:kill)
        @hijack_fetch_threads.clear
        @hijack_fetch_queue.clear
      end

      # MessageBus's `long_polling_interval` defaults to 25 s — its
      # `cleanup_timer` fires after that interval, closing the
      # hijacked connection with an empty `[]` write. Pick a slightly
      # larger wall cap so the close reaches us before our pipe read
      # gives up. Other hijack-using middleware likely behaves
      # similarly; if any need much longer waits, this becomes a per-
      # request option.
      HIJACK_PIPE_MAX_WAIT_S = 30

      private def run_hijacked_pipe_read(id, read_io, queue)
        buf = String.new
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + HIJACK_PIPE_MAX_WAIT_S
        loop do
          remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
          break if remaining <= 0
          ready, = IO.select([read_io], nil, nil, remaining)
          break unless ready
          begin
            buf << read_io.read_nonblock(8192)
          rescue EOFError, Errno::EPIPE, Errno::ECONNRESET
            break
          rescue IO::WaitReadable
            next
          end
        end
        queue << {'handle' => id, **parse_hijacked_http_response(buf)}
      rescue StandardError => e
        queue << {'handle' => id, 'status' => 0, 'headers' => {}, 'body' => '', 'error' => "#{e.class}: #{e.message}"}
      ensure
        @hijack_fetch_threads.delete(id)
        begin
          read_io.close unless read_io.closed?
        rescue StandardError
          # pipe already closed by the middleware; ignore.
        end
      end

      # Hijacked middleware writes raw HTTP/1.1 over the socket:
      # `HTTP/1.1 200 OK\r\nheader: value\r\n...\r\n\r\nbody`.
      private def parse_hijacked_http_response(buf)
        status   = 200
        headers  = {}
        sep_idx  = buf.index("\r\n\r\n") || buf.index("\n\n")
        head, body =
          if sep_idx
            sep_len = buf[sep_idx, 4] == "\r\n\r\n" ? 4 : 2
            [buf[0...sep_idx], buf[(sep_idx + sep_len)..]]
          else
            [buf, '']
          end
        head.split(/\r?\n/).each_with_index do |line, i|
          if i == 0 && (m = line.match(%r{\AHTTP/[\d.]+\s+(\d+)}))
            status = m[1].to_i
          elsif (idx = line.index(':'))
            k = line[0...idx].strip.downcase
            v = line[(idx + 1)..].to_s.strip
            headers[k] = v
          end
        end
        {'status' => status, 'headers' => headers, 'body' => body.to_s}
      end

      private def normalize_response_headers(headers)
        return {} unless headers
        out = {}
        headers.each {|k, v| out[k.to_s.downcase] = v.to_s }
        out
      end

      # ── Web Workers ────────────────────────────────────────────────
      #
      # `new Worker(url)` in JS lands in `worker_spawn`. The Ruby
      # thread it spawns owns a fresh V8 Context / QuickJS VM (true
      # isolate, separate microtask queue and timer table), evals the
      # worker script there, and runs an event loop draining timers,
      # microtasks, and the inbox queue from the main thread. Each
      # worker's `__csim_workerPostMessage` host fn closes over its
      # handle and routes outgoing messages onto a shared outbox the
      # main settle drains.
      def worker_spawn(url)
        handle       = (@worker_seq += 1)
        inbox        = Thread::Queue.new
        outbox       = @worker_outbox
        engine_class = @runtime.class
        target       = resolve_against_current(url.to_s)
        # Resolve the worker script body on the main thread before
        # handing off to the worker. `blob:` URLs need the main VM's
        # blob registry; calling into the main runtime from a
        # non-owning thread SEGVs (mini_racer is V8-isolate-thread-
        # bound; quickjs.rb's VM is similarly per-thread).
        body = fetch_worker_script(target)
        thread = Thread.new do
          Thread.current.report_on_exception = false
          run_worker(handle, target, body, inbox, outbox, engine_class)
        end
        @workers[handle] = {thread: thread, inbox: inbox}
        handle
      end

      def worker_post_to_worker(handle, data)
        w = @workers[handle.to_i]
        return unless w
        @worker_in_flight += 1
        w[:inbox] << data.to_s
      end

      def worker_terminate(handle)
        w = @workers.delete(handle.to_i)
        return unless w
        w[:inbox] << :terminate
        # Most clean shutdowns are <10 ms; the kill is the fallback
        # for blocked workers.
        w[:thread].join(WORKER_TERMINATE_GRACE)
        w[:thread].kill if w[:thread].alive?
        # A blocked worker that never returned messages leaves
        # `@worker_in_flight` permanently > 0; reset when no workers
        # remain so `polling?` can short-circuit again.
        @worker_in_flight = 0 if @workers.empty?
      end

      def deliver_worker_messages
        return 0 if @workers.empty? && @worker_outbox.empty?
        events = drain_queue(@worker_outbox)
        return 0 if events.empty?
        # `__error` postbacks don't correspond to a prior post, so
        # bottom out at zero.
        @worker_in_flight = [0, @worker_in_flight - events.size].max
        @runtime.call('__csim_deliverWorkerMessages', events)
        events.size
      end

      def worker_pending? = !@worker_outbox.empty? || @worker_in_flight > 0

      # ── Image decode (libvips) ─────────────────────────────────────
      #
      # Called by the JS bridge whenever a Canvas / OffscreenCanvas
      # path needs raw RGBA pixels — `drawImage(image, …)` whose
      # source is an HTMLImageElement / Blob / ImageBitmap with
      # encoded bytes still on the wire. ruby-vips decodes any format
      # libvips supports (PNG, JPEG, WebP, GIF, …) into a contiguous
      # row-major RGBA buffer. Returns `{width, height, refId}` — the
      # raw bytes land in the transfer-buffer registry so the JS side
      # fetches them as a `Uint8Array` via `MiniRacer::Binary` rather
      # than building a 423 MB latin-1 + base64 intermediate for the
      # 8900×8900 frames Discourse uploads exercise. Optional
      # `max_w`/`max_h` lets the caller pre-shrink for cheap OCR-style
      # "downscale before pixel-touch" flows.
      def decode_image(b64_bytes, max_w = nil, max_h = nil)
        host_image_op('decode_image') {
          require 'vips' unless defined?(Vips)
          bytes = Base64.decode64(b64_bytes.to_s)
          # `access: :sequential` keeps libvips from applying the
          # source's ICC profile mid-stream (changes RGBA values by ±2
          # vs raw decode). `colourspace('srgb')` is the same ICC
          # transform Chrome's createImageBitmap runs, but rounding
          # differs by a few ulp; only convert when libvips reports
          # a non-sRGB interpretation, otherwise trust the bytes.
          img   = Vips::Image.new_from_buffer(bytes, '', access: :sequential)
          img   = img.colourspace('srgb') unless img.interpretation == :srgb || img.interpretation == :rgb
          img   = img.bandjoin(255) if img.bands < 4
          if max_w && max_h && max_w.to_i > 0 && max_h.to_i > 0 &&
             (img.width > max_w.to_i || img.height > max_h.to_i)
            shrink_x = img.width.to_f  / max_w.to_i
            shrink_y = img.height.to_f / max_h.to_i
            shrink  = [shrink_x, shrink_y].max
            img     = img.resize(1.0 / shrink) if shrink > 1
          end
          raw = img.write_to_memory
          {'width' => img.width, 'height' => img.height, 'refId' => transfer_buffer_stash(raw)}
        }
      end

      private def host_image_op(name)
        yield
      rescue LoadError, StandardError => e
        warn "[capybara-simulated] #{name} failed: #{e.class}: #{e.message[0, 200]}"
        nil
      end

      def reset_workers
        @workers.each_value do |w|
          w[:inbox] << :terminate
          w[:thread].kill
        end
        @workers.clear
        @worker_outbox.clear
        @worker_in_flight = 0
        @transfer_buffer_lock.synchronize {
          @transfer_buffers.clear
          @transfer_buffer_seq = 0
        }
      end

      def blob_register(url, body_b64)
        @blob_registry_lock.synchronize { @blob_registry[url.to_s] = body_b64.to_s }
        nil
      end

      def blob_resolve(url)
        @blob_registry_lock.synchronize { @blob_registry[url.to_s] }
      end

      def blob_unregister(url)
        @blob_registry_lock.synchronize { @blob_registry.delete(url.to_s) }
        nil
      end

      # ── postMessage transferable-buffer registry ───────────────────
      #
      # Large Uint8Array / ArrayBuffer payloads cross isolates by ID;
      # mini_racer marshals typed arrays as ASCII-8BIT Strings so no
      # JS-side latin-1 / base64 intermediate is built. Without this
      # the 317 MB raw frames in Discourse's media-optimization-worker
      # peak >4 GB of JS strings before the worker even sees them.
      def transfer_buffer_stash(bytes)
        s = bytes.to_s
        s = s.dup.force_encoding(Encoding::ASCII_8BIT) unless s.encoding == Encoding::ASCII_8BIT
        @transfer_buffer_lock.synchronize {
          id = (@transfer_buffer_seq += 1)
          @transfer_buffers[id] = s
          id
        }
      end

      def transfer_buffer_fetch(id)
        @transfer_buffer_lock.synchronize { @transfer_buffers.delete(id.to_i) }
      end

      # Wraps the raw bytes so mini_racer marshals them as a Uint8Array
      # on the JS side. QuickJS has no binary marshaler — strings get
      # reinterpreted as UTF-8 and high-bit bytes corrupt, so we base64
      # the payload there and the JS shim's `fetchedToBytes` atob's.
      def transfer_buffer_fetch_for_js(id)
        bytes = transfer_buffer_fetch(id)
        return nil unless bytes
        return MiniRacer::Binary.new(bytes) if defined?(MiniRacer::Binary)
        Base64.strict_encode64(bytes)
      end

      # ── Video decode (ffprobe + ffmpeg) ────────────────────────────
      #
      # Called from the JS bridge when a `<video>` element's `src` is
      # assigned a `blob:` URL. ffprobe extracts dimensions + duration,
      # ffmpeg extracts the first frame as raw RGBA. JS caches both so
      # `canvas.drawImage(video, …)` blits like any ImageBitmap.
      def decode_video_frame(b64_bytes)
        host_image_op('decode_video_frame') {
          bytes = Base64.decode64(b64_bytes.to_s)
          next nil if bytes.empty?
          require 'tempfile'
          require 'json'
          Tempfile.create(['csim-video', '.bin'], binmode: true) do |f|
            f.write(bytes)
            f.flush
            info   = ffprobe_stream(f.path) or break nil
            width  = info['width'].to_i
            height = info['height'].to_i
            break nil if width <= 0 || height <= 0
            raw = ffmpeg_first_frame_rgba(f.path)
            duration = (info['duration'] || info.dig('format_duration')).to_f
            result   = {'width' => width, 'height' => height, 'duration' => duration}
            result['refId'] = transfer_buffer_stash(raw) if raw && !raw.empty?
            result
          end
        }
      end

      private def ffprobe_stream(path)
        json = IO.popen(
          ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
           '-show_entries', 'stream=width,height,duration:format=duration',
           '-of', 'json', path],
          'r', err: File::NULL,
          &:read
        )
        return nil unless $?.success?
        parsed = JSON.parse(json) rescue {}
        info   = parsed.dig('streams', 0) || {}
        info['format_duration'] = parsed.dig('format', 'duration')
        info
      end

      private def ffmpeg_first_frame_rgba(path)
        raw = IO.popen(
          ['ffmpeg', '-loglevel', 'error', '-i', path,
           '-frames:v', '1', '-f', 'image2pipe',
           '-vcodec', 'rawvideo', '-pix_fmt', 'rgba', '-'],
          'rb', &:read
        )
        $?.success? ? raw : nil
      end

      # ── Image encode (libvips) ─────────────────────────────────────
      #
      # `canvas.toBlob`'s Ruby end. The pixel buffer comes in via the
      # transfer registry (so JS doesn't build a megabyte-scale b64
      # intermediate); the encoded image goes back the same way. Returns
      # `{refId, type}` or nil on encoder failure.
      MIME_TO_VIPS_EXT = {
        'image/jpeg' => '.jpg',
        'image/jpg'  => '.jpg',
        'image/webp' => '.webp',
        'image/png'  => '.png'
      }.freeze
      private_constant :MIME_TO_VIPS_EXT

      def encode_image(pixels_ref, width, height, mime_type = 'image/png', quality = 90)
        host_image_op('encode_image') {
          require 'vips' unless defined?(Vips)
          raw = transfer_buffer_fetch(pixels_ref).to_s
          w   = width.to_i
          h   = height.to_i
          next nil if w <= 0 || h <= 0 || raw.bytesize < w * h * 4
          img = Vips::Image.new_from_memory_copy(raw, w, h, 4, :uchar)
          ext = MIME_TO_VIPS_EXT[mime_type.to_s.downcase] || '.png'
          opts = (ext == '.jpg' || ext == '.webp') ? {Q: quality.to_i} : {}
          {'refId' => transfer_buffer_stash(img.write_to_buffer(ext, **opts))}
        }
      end

      def webauthn = (@webauthn ||= WebauthnState.new)

      # Worker thread entry. Builds an isolate via the engine class's
      # `build_worker` factory, evaluates the worker script, then
      # loops draining microtasks + timers + inbox until `:terminate`
      # lands or an exception propagates.
      private def run_worker(handle, url, body, inbox, outbox, engine_class)
        raise "worker script not found: #{url}" unless body
        post_back = ->(data) { outbox << {handle: handle, kind: 'message', data: data.to_s} }
        rt        = engine_class.build_worker(self, post_back)
        # Set the worker's `self.location.href` so webpack /
        # rollup public-path derivation + `new URL(rel, import.meta.url)`
        # resolve chunks against the worker's own origin rather than
        # the snapshot-time `http://placeholder/`.
        rt.eval("globalThis.__csimUpdateLocation(#{JSON.generate(url.to_s)});")
        rt.eval(body)
        loop do
          msg = pop_with_timeout(inbox, WORKER_POLL_INTERVAL)
          break if msg == :terminate
          rt.call('__csim_workerOnMessage', msg) if msg
          rt.drain_microtasks
          rt.drain_timers if rt.has_ready_timer?
        end
      rescue StandardError => e
        outbox << {handle: handle, kind: '__error', message: "#{e.class}: #{e.message}"}
      ensure
        rt&.dispose
      end

      # Bundlers that ship a worker inline as a Blob (Tesseract,
      # Webpack `?worker` imports, Vite worker chunks) construct
      # `new Worker(blobURL)`. Rack can't parse `blob:` so short-
      # circuit to the JS-side blob registry instead. Http(s) URLs
      # fall through to the regular Rack path.
      private def fetch_worker_script(url)
        return rack_fetch_body(url) unless url.to_s.start_with?('blob:')
        b64 = @runtime.call('__csimReadBlobBase64', url)
        return nil unless b64
        Base64.decode64(b64.to_s)
      end

      # `Thread::Queue#pop(timeout:)` blocks releasing the GVL — fine
      # because the worker thread has nothing else to do while idle,
      # and `worker_post_to_worker` wakes the wait immediately.
      private def pop_with_timeout(queue, seconds)
        queue.pop(timeout: seconds)
      rescue ThreadError
        nil
      end

      # Drain everything currently in a Thread::Queue without
      # blocking. Shared between `event_source_poll` and
      # `deliver_worker_messages`.
      private def drain_queue(queue)
        out = []
        loop do
          out << queue.pop(true)
        rescue ThreadError
          break
        end
        out
      end

      # JS-side `ingestImportmaps` calls this through the host fn so
      # Ruby-side `resolve_module_specifier` agrees with the bare-
      # specifier map shipped by `<script type="importmap">`.
      def set_importmap(json)
        @importmap = JSON.parse(json.to_s)
      rescue JSON::ParserError
        @importmap = {'imports' => {}, 'scopes' => {}}
      end

      def resolve_module_specifier(specifier, base_url)
        @importmap ||= {'imports' => {}, 'scopes' => {}}
        if (mapped = @importmap['imports'][specifier])
          return resolve_against(mapped, base_url)
        end
        if specifier.start_with?('/', './', '../') || specifier.match?(%r{\A[a-z]+://}i)
          return resolve_against(specifier, base_url)
        end
        specifier
      end

      def resolve_against(url, base)
        return url if url =~ %r{\A[a-z]+://}i
        # quickjs.rb's module_loader passes the importer for nested
        # relative imports; if the importer was an inline-script
        # pseudo-name (no scheme), fall through to the page URL.
        base = nil unless base.is_a?(String) && base =~ %r{\A[a-z]+://}i
        eff = base || @current_url || @default_host
        # Memo of `URI.join(eff, url)` — a pure function of (effective base, url).
        # A heavy ESM app re-resolves the same ~80 module specifiers against the
        # same base on every visit (a fresh VM re-instantiates the whole module
        # graph); Ruby's URI parser was a measured ~11% of per-visit wall. The
        # Browser persists across a suite's visits, so this instance-level memo
        # (same scope/threading assumptions as @importmap / @current_url) turns
        # all but the first visit's resolves into hash hits.
        cache = (@resolve_against_cache ||= {})
        cache[[eff, url]] ||= begin
          URI.join(eff, url).to_s
        rescue URI::InvalidURIError, URI::BadURIError
          url
        end
      end

      MAX_FETCH_REDIRECTS = 20
      # URLs we won't even try to route through Rack: anything that
      # isn't http(s) (data: / mailto: / about:) plus pseudo-tokens
      # like V8's `<snapshot>` that sourcemap libraries pull out of
      # error stacks and feed straight to `fetch()` / `xhr.open()`.
      def rack_fetch(method, url, body, headers, redirect_mode, env_extras: nil)
        target = resolve_against_current(url.to_s)
        return nil unless target.is_a?(String) && target.match?(%r{\Ahttps?://}i)
        method = (method || 'GET').to_s.upcase
        redirected = false
        # JS-side base64-encodes Blob/File bodies (raw bytes survive
        # mini_racer's UTF-8 string boundary that way); decode before
        # handing to Rack so the upload PUT lands intact.
        if headers.is_a?(Hash) && headers['X-Csim-Body-B64'].to_s == '1'
          body = Base64.decode64(body.to_s)
          headers = headers.reject {|k, _| k == 'X-Csim-Body-B64' }
        end
        MAX_FETCH_REDIRECTS.times do
          # GET-only cache shortcut (RFC 9111). Fresh hit → skip @app.call
          # entirely; stale-but-revalidatable → fall through with conditional
          # headers added so the server can return 304.
          cache_entry = method == 'GET' ? @@asset_cache.lookup(target) : nil
          if cache_entry&.fresh?
            log_network(method, target, cache_entry.status)
            return response_hash(cache_entry.status, cache_entry.headers, cache_entry.body, target, redirected)
          end

          env = Rack::MockRequest.env_for(target, method: method, input: body || '')
          apply_request_headers(env, headers) if headers
          apply_request_headers(env, @@asset_cache.revalidation_headers(cache_entry)) if cache_entry
          apply_default_request_env(env, referer: @current_url, force: false)
          env.merge!(env_extras) if env_extras
          status, resp_headers, resp_body = dispatch_rack_or_http(target, env, method: method, body: body)
          merge_set_cookie(resp_headers)
          log_network(method, target, status)
          if status == 304 && cache_entry
            resp_body.close if resp_body.respond_to?(:close)
            @@asset_cache.refresh(cache_entry, resp_headers)
            return response_hash(cache_entry.status, cache_entry.headers, cache_entry.body, target, redirected)
          end
          if redirect_mode != 'manual' && (loc = redirect_location(status, resp_headers))
            raise StandardError, '[capybara-simulated] fetch: redirect blocked by redirect=error mode' if redirect_mode == 'error'
            redirected = true
            preserve = [307, 308].include?(status)
            next_url = resolve_against(loc, target)
            target = carry_fragment(target, next_url)
            method = 'GET' unless preserve
            body = nil unless preserve
            resp_body.close if resp_body.respond_to?(:close)
            next
          end
          body_str = read_rack_body(resp_body)
          @@asset_cache.store(target, status, resp_headers, body_str) if method == 'GET'
          return response_hash(status, resp_headers, body_str, target, redirected)
        end
        raise StandardError, "[capybara-simulated] fetch exceeded #{MAX_FETCH_REDIRECTS} redirects"
      rescue StandardError => e
        warn "[capybara-simulated] rack_fetch failed: #{e.class}: #{e.message[0, 200]}"
        nil
      end

      # CGI convention: `Content-Type` and `Content-Length` land in env
      # *without* the HTTP_ prefix. Rails / Rack params parsing reads
      # `CONTENT_TYPE` and dispatches JSON / multipart parsers off it;
      # sending it as `HTTP_CONTENT_TYPE` lets the request through but
      # with the default `text/plain`, so JSON bodies from
      # `@rails/request.js` never deserialise and the server reads an
      # empty params hash.
      def apply_request_headers(env, headers)
        headers.each {|k, v|
          name = k.to_s.upcase.tr('-', '_')
          case name
          when 'CONTENT_TYPE', 'CONTENT_LENGTH' then env[name] = v.to_s
          else env["HTTP_#{name}"] = v.to_s
          end
        }
      end

      # Content types whose bytes are already representable in the
      # UTF-8 string that ships back to JS — base64 wouldn't add
      # anything and `Base64.strict_encode64` is ~1 % of suite wall
      # time on Discourse. Binary types (images, octet-stream,
      # gzipped traineddata, etc.) still need `body_b64` because V8 /
      # QuickJS mangle bytes 0x80-0xFF over the UTF-8 string boundary.
      # `fetch.js#_decodeBytes` and `xhr.js` both fall back to the
      # text body when `body_b64` is absent.
      TEXT_CONTENT_TYPE_PREFIXES = %w[text/ application/json application/javascript application/ecmascript application/xml image/svg+xml].freeze

      def response_hash(status, headers, body, url, redirected)
        body_str = body.to_s
        out = {
          'status'     => status,
          'headers'    => stringify(headers),
          'body'       => body_str,
          'url'        => url,
          'redirected' => redirected,
          'type'       => 'basic'
        }
        out['body_b64'] = Base64.strict_encode64(body_str) unless text_response?(out['headers'])
        out
      end

      def text_response?(headers)
        ct = (headers['content-type'] || headers['Content-Type']).to_s.downcase
        return false if ct.empty?
        TEXT_CONTENT_TYPE_PREFIXES.any? {|p| ct.start_with?(p) }
      end

      # Rack response bodies must respond to `each` (or be an Array of
      # strings). `to_s` on a streaming body returns the inspect form,
      # not the bytes — which silently shipped 43-byte `#<Rack::Files…>`
      # strings to the JS engine for big assets like jquery.js.
      def read_rack_body(body)
        buf = +''
        body.each {|chunk| buf << chunk.to_s } if body.respond_to?(:each)
        body.close if body.respond_to?(:close)
        buf
      end

      # Defer the navigation: doing it from inside the running V8 call
      # would dispose the Context mid-call. tick_real_time drains
      # after the call returns. Same pattern as `__csimPendingFormSubmit`.
      def location_assign(url)
        @pending_location = resolve_against_current(url.to_s)
      end
      def consume_pending_location
        return unless (url = @pending_location)
        @pending_location = nil
        navigate(url)
      end
      # Mirror of `location_assign`'s deferral for `location.reload()`:
      # the JS call lands here from `__locationReload`; running
      # `browser.refresh` directly would `navigate` (rebuilding the
      # Context) while we're still inside the V8 call, which V8
      # terminates with a `ScriptTerminatedError`. Stash the intent
      # and drain it from `tick_real_time` after the call returns.
      def location_reload   ; @pending_reload = true ; end
      def consume_pending_reload
        return unless @pending_reload
        @pending_reload = false
        refresh
      end
      def drain_pending_navigation
        consume_pending_location
        consume_pending_reload
        consume_pending_history_traverse
      end
      # POST-after-POST resubmits with the original body; GET-after-GET
       # is just a re-GET. Replay the current history entry.
      def refresh
        replay_history_entry(@history[@history_idx])
      end
      # `history.pushState(state, '', '/path')` ships the URL through
      # `__setCurrentUrl` and lands here. Tab controllers / SPA frameworks
      # pass a relative path; resolve it against the existing absolute
      # `@current_url` so subsequent `resolve_against_current(href)`
      # calls (e.g. click_link to a relative href) don't hit
      # `URI::BadURIError: both URI are relative`.
      # `history.replaceState(state, _, url)` updates the current entry
      # in place rather than appending. Both the state and (when given)
      # the URL are mirrored on Ruby's slot so a subsequent back to
      # this entry restores the same state.
      def history_state(url, state = nil)
        if url
          resolved = resolve_against_current(url.to_s)
          record_url_transition(resolved)
          @current_url = resolved
        end
        return if @history_idx < 0
        @history[@history_idx] = (@history[@history_idx] || {}).merge(
          url:   @current_url,
          state: state,
          kind:  @history[@history_idx] ? @history[@history_idx][:kind] : :push_state
        )
      end
      # `history.pushState(state, _, url)` from SPA navigation (Turbo
      # Visit, InstantClick, …) appends a new browser-history entry.
      # Mirror that on the Ruby side so `Capybara#go_back` traverses
      # within the pushState chain (fires `popstate`) and only crosses
      # to a real reload when the back hits a `:visit` boundary.
      def history_push(url, state = nil)
        resolved = resolve_against_current(url.to_s)
        record_url_transition(resolved)
        @current_url = resolved
        record_history({method: :get, url: resolved, state: state, kind: :push_state})
      end

      # Total history entries (after forward-tail truncation), surfaced
      # to JS `history.length` via the `__historyLength` host fn.
      def history_length
        [@history.size, 1].max
      end
      def document_cookie      ; @cookies.map {|k, v| "#{k}=#{v}" }.join('; ') ; end
      def current_referer      ; @current_referer.to_s ; end
      def write_document_cookie(s)
        return if s.nil? || s.empty?
        name, rest = s.split('=', 2)
        return if name.nil? || name.empty?
        parts = (rest || '').split(';').map(&:strip)
        value = parts.shift.to_s
        if cookie_deletion?(parts)
          @cookies.delete(name.strip)
        else
          @cookies[name.strip] = value
        end
      end

      # Web Storage host-fn shims. The Ruby-side hashes survive
      # `rebuild_ctx` between visits, so apps that cache user data in
      # `localStorage` on page A (Forem's `browserStoreCache('set')`
      # inside fetchBaseData) see it on page B — without this, every
      # visit boots into a JS-side Map that starts empty and the
      # first-call branches that hinge on cached user data (the
      # onboarding task-card render, `initializeLocalStorageRender`,
      # etc.) silently skip.
      def storage_get(kind, key)
        store(kind)[key.to_s]
      end
      def storage_set(kind, key, value)
        store(kind)[key.to_s] = value.to_s
        nil
      end
      def storage_remove(kind, key)
        store(kind).delete(key.to_s)
        nil
      end
      def storage_clear(kind)
        store(kind).clear
        nil
      end
      def storage_key(kind, index)
        store(kind).keys[index.to_i]
      end
      def storage_length(kind)
        store(kind).size
      end
      private def store(kind)
        kind.to_s == 'session' ? @session_storage : @local_storage
      end
      # Push a one-shot handler onto the modal-dialog stack — the next
      # modal that fires consumes the topmost handler. Block exit pops
      # in case the dialog never fired.
      def with_modal(handler)
        @modal_handlers.push(handler)
        yield if block_given?
      ensure
        @modal_handlers.delete(handler)
      end

      # JS-side `alert(...)` / `confirm(...)` / `prompt(...)` route here.
      # If no handler is pushed (typical of apps under test), accept
      # the dialog (Rails system-test default) so `data-turbo-confirm`
      # / similar progress without an explicit `accept_confirm` in
      # the test.
      def handle_modal(type, message, default_value)
        handler = @modal_handlers.pop
        if handler
          handler.call(type, message, default_value)
        else
          case type.to_s
          when 'alert'   then nil
          when 'confirm' then true
          when 'prompt'  then default_value.to_s
          end
        end
      end

      private

      # Fetch via the Rack app and hand the body to V8 for parsing.
      # Only follows 3xx redirects up to a small depth.
      def navigate(url, depth: 0, referer: @current_url, from_history: false)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
        # Capture the entry referer (the page initiating this navigation,
        # e.g. clicked link's host page) at depth 0 — internal redirects
        # at deeper depths don't replace the user-visible referrer.
        # A full-document navigate also clears the pushState transition
        # queue: any URLs we'd queued during the prior page's lifetime
        # are stale once we cross a real document boundary.
        if depth == 0
          @current_referer = referer.to_s
          @recent_urls.clear if @recent_urls
          @recent_urls_last_push_at = nil
        end
        # While navigate is in progress (and the loaded page's bootstrap
        # JS is running synchronously inside __csimLoadDocument), any
        # `history.pushState`/`replaceState` chain belongs to that load
        # — record intermediates so a polling matcher can walk them.
        prior_navigating = @navigating
        @navigating = true unless from_history
        begin
          record_history({method: :get, url: url}) unless from_history || depth > 0
          env = Rack::MockRequest.env_for(url, method: 'GET')
          apply_default_request_env(env, referer: referer)
          status, headers, body = dispatch_rack_or_http(url, env, method: 'GET')
          merge_set_cookie(headers)
          if (loc = redirect_location(status, headers))
            next_url = resolve_against_current(loc)
            # Per RFC 7231: if the original request URL had a fragment
            # and the redirect target doesn't specify one, preserve
            # the original fragment in the final URL.
            next_url = carry_fragment(url, next_url)
            body.close if body.respond_to?(:close)
            return navigate(next_url, depth: depth + 1)
          end
          # Track the navigated URL even for download-shaped responses
          # so an aux window opened on a binary asset (PDF / image
          # opened via `target=_blank`) still reports `current_url`
          # correctly to within_window assertions.
          @current_url = url
          if download_response?(headers)
            save_downloaded_response(url, headers, body)
            return
          end
          record_response(status, headers)
          html         = read_rack_body(body)
          # Full-reload navigation rebuilds the JS Context from the warm
          # snapshot. Per-visit fresh VM avoids partial-reset drift
          # (jQuery `.ready`, rails-ujs `_rails_loaded`, accumulated
          # `$(document).on(...)` delegates) — snapshot warmup keeps the
          # rebuild itself cheap; app-bundle re-eval dominates.
          boot_response_into_ctx(html)
        ensure
          @navigating = prior_navigating
        end
      end

      # Rebuild the JS Context and load `html` into it. Called from
      # every code path that handles a full-page Rack response (`navigate`
      # for GETs, `navigate_post` for POSTs). `__csimLoadDocument` walks
      # importmaps + module scripts during `runInlineScripts`; the bridge
      # pushes the importmap back via `__csim_pushImportmap` before any
      # module loads so resolver lookups agree with the JS side.
      #
      # The post-nav grace bridges Capybara's outer-synchronize gap when
      # the new page has no scripts of its own to flip `@timers_active`
      # (e.g. Avo's `redirect_to main_app.hey_path` → static view). Kept
      # small (~10 retry intervals) so failing-assertion paths don't pay
      # for the wait.
      def boot_response_into_ctx(html)
        # Before discarding the OUTGOING page's VM, flush its DUE-NOW init work so
        # persistent side effects (localStorage / cookies) survive into the next
        # page. forem's login redirect kicks off `fetchBaseData` — a
        # `setTimeout(0)` (fetch.js) whose `.then` writes `current_user` to
        # localStorage — but the interactive gen-yield `settle` bails on the first
        # init mutation before that due-now fetch fires; without this flush the
        # cache write is lost on rebuild and the next page (which reads it
        # synchronously to reveal logged-in UI) renders as logged-out. `maxMs: 0`
        # fires only ALREADY-due timers (the setTimeout(0) + its `.then` chain),
        # NOT delayed timers — so the lazy wall-sync timer model is preserved (a
        # freshly-loaded, not-yet-navigated-away page keeps its own pending
        # setTimeout(0)s untouched; smoke_spec "queries DOM before advancing
        # pending timers"). A real browser lets the outgoing page's in-flight init
        # finish before the next document loads; this is the in-process analogue.
        flush_outgoing_page_init if @timers_active
        @runtime.rebuild_ctx
        reset_timer_state
        opts = {
          'traceActive'        => !@trace.nil?,
          'timezone'           => ENV['TZ'].to_s,
          'timeTravelOffsetMs' => ((Time.now.to_f - Process.clock_gettime(Process::CLOCK_REALTIME)) * 1000).to_i,
          'url'                => @current_url.to_s,
          'html'               => html
        }
        # Carry the response content type so the JS side can pick the XML vs
        # HTML parser (XHTML / XML / SVG documents parse case-sensitively, with
        # no html/head/body skeleton, and report `isHtmlDocument` false).
        ct = (@last_response_headers || {}).find {|k, _| k.to_s.downcase == 'content-type' }&.last
        ct = ct.first if ct.is_a?(Array)
        opts['contentType'] = ct.to_s if ct && !ct.to_s.empty?
        if @viewport_width && @viewport_height
          opts['viewportW'] = @viewport_width
          opts['viewportH'] = @viewport_height
        end
        opts['userAgent'] = @default_user_agent if @default_user_agent
        @document_handle = @runtime.call('__csimBootContext', opts).to_i
        @polling_grace = POST_NAV_POLL_GRACE_POLLS
      end

      # Run one due-now event-loop step on the OUTGOING page (see
      # `boot_response_into_ctx`). The outgoing page's timers may call
      # `location.* / history.* / reload`, which only STASH a Ruby-side intent —
      # but we are navigating away, so those intents are moot and must NOT leak
      # into the page we are about to load (otherwise the next find's
      # `tick_real_time` would consume a stray `@pending_location` and navigate
      # off the freshly-loaded page). Snapshot/restore the nav-intent slots to
      # keep the flush transparent; swallow any throw so a flaky outgoing-page
      # timer can't abort loading the next page (the page it would affect is
      # being discarded on the very next line).
      def flush_outgoing_page_init
        saved_location = @pending_location
        saved_reload   = @pending_reload
        saved_traverse = @pending_history_traverse
        begin
          @runtime.run_loop_step(0, SETTLE_MAX_ITER_TASKS, yield_on_gen: false)
        rescue StandardError
          # Outgoing page is discarded next line; its flush error is moot.
        ensure
          @pending_location         = saved_location
          @pending_reload           = saved_reload
          @pending_history_traverse = saved_traverse
        end
      end

      # `Content-Disposition: attachment` (or any explicit filename
      # in inline form) is the canonical "save to disk" signal that
      # browsers honour. Tests that exercise CSV / PDF / etc. exports
      # use Redmine's `downloaded_file` helper to read the bytes
      # back from `tmp/downloads/`; routing the response through the
      # save path here keeps the page state unchanged (no rebuild),
      # mirroring what a real browser does after a download.
      def content_disposition_header(headers)
        headers['content-disposition'] || headers['Content-Disposition']
      end

      def download_response?(headers)
        cd = content_disposition_header(headers)
        cd && cd.to_s.match?(/(?:^|;)\s*(attachment|filename\s*=)/i)
      end

      def save_downloaded_response(url, headers, body)
        cd = content_disposition_header(headers).to_s
        m = cd.match(/filename\*?\s*=\s*(?:"([^"]+)"|([^;]+))/i)
        filename = (m && (m[1] || m[2]) || '').strip
        filename = File.basename(URI.parse(url.to_s).path.to_s) if filename.empty?
        filename = 'download' if filename.empty?
        dir = downloads_directory
        FileUtils.mkdir_p(dir)
        File.binwrite(File.join(dir, filename), read_rack_body(body))
      end

      def downloads_directory
        ENV['CSIM_DOWNLOADS_DIR'] || Capybara.save_path || File.join(Dir.pwd, 'tmp', 'downloads')
      end

      # Stamps the default headers every driver-originated request
      # carries: UA, REMOTE_ADDR, cookies, referer, and any sticky
      # headers a previous response asked us to echo. `force: false`
      # (the rack_fetch path) preserves any value the caller already
      # set on `env`, so JS-supplied `XHR.setRequestHeader` /
      # `fetch(..., {headers: ...})` overrides win.
      DEFAULT_HTTP_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'.freeze

      def apply_default_request_env(env, referer:, force: true)
        # `Rack::MockRequest.env_for` populates `SERVER_NAME` /
        # `SERVER_PORT` from the URL but leaves `HTTP_HOST` nil. Read
        # SERVER_NAME so the IPv4/IPv6 loopback choice still matches
        # what real Chrome would have done after DNS resolution.
        if force
          env['HTTP_USER_AGENT'] = @default_user_agent || USER_AGENT
          env['REMOTE_ADDR']     = self.class.remote_addr_for(env['HTTP_HOST'] || env['SERVER_NAME'])
          @sticky_headers.each {|k, v| env["HTTP_#{k.upcase.tr('-', '_')}"] = v }
        else
          env['HTTP_USER_AGENT'] ||= (@default_user_agent || USER_AGENT)
          env['REMOTE_ADDR']     ||= self.class.remote_addr_for(env['HTTP_HOST'] || env['SERVER_NAME'])
          @sticky_headers.each {|k, v| env["HTTP_#{k.upcase.tr('-', '_')}"] ||= v }
        end
        # Browsers always send an `Accept` header; Rack::MockRequest
        # leaves it nil, which Rails reads as `Mime::HTML` *only* in
        # its formats list. Controllers with only `format.turbo_stream`
        # (Avo's actions / flash-render path) then raise
        # `ActionController::UnknownFormat`. Send the same
        # wildcard-trailing Accept Chromium / Firefox use so the
        # server can negotiate — HTML-only routes still pick html,
        # both-available pick the first registered.
        env['HTTP_ACCEPT'] ||= DEFAULT_HTTP_ACCEPT
        env['HTTP_REFERER'] = referer         unless referer.nil? || referer.empty?
        env['HTTP_COOKIE']  = document_cookie unless @cookies.empty?
      end

      # Cross-host hop (e.g. Discourse's `discourse_connect` flow
      # redirecting to a real WEBrick on `localhost:9100`) must cross
      # the wire — Rails' router doesn't have routes for the external
      # server's paths, and the external server's redirect back to the
      # app host needs to come through @app again. Real-browser drivers
      # get this for free; we have to detect the boundary.
      def dispatch_rack_or_http(url, env, method: 'GET', body: nil)
        return @app.call(env) if url_is_local?(url)
        # External fetch: if the network is blocked (WebMock) or the
        # host is unreachable, fall back to @app — Rails will 404 or
        # otherwise handle it, matching the pre-cross-host behavior
        # for tests that route through an external OAuth provider URL
        # without intending the call to land.
        net_http_fetch(url, env, method: method, body: body) || @app.call(env)
      end

      # Path-only or fragment-only URLs are always against the current
      # origin. For absolute URLs, compare host:port to the cached
      # parsed @current_url (or default_host on first navigate).
      def url_is_local?(url)
        s = url.to_s
        return true if s.empty? || s.start_with?('/', '#', '?')
        uri = safe_uri(s)
        return true if uri.nil? || uri.host.nil?
        ref = current_url_uri || safe_uri(@default_host.to_s)
        return true unless ref&.host
        uri.host == ref.host && effective_port(uri) == effective_port(ref)
      end

      def safe_uri(s)
        URI.parse(s) rescue nil
      end

      def current_url_uri
        return nil if @current_url.nil?
        return @current_url_uri if @current_url_uri_cached_for.equal?(@current_url)
        @current_url_uri_cached_for = @current_url
        @current_url_uri = safe_uri(@current_url)
      end

      def effective_port(uri)
        uri.port || (uri.scheme == 'https' ? 443 : 80)
      end

      # Returns a Rack-shaped triple, or `nil` if the network attempt
      # failed for any reason — the caller falls back to @app.call so
      # WebMock-blocked external URLs (Discourse's OAuth provider
      # redirects) still round-trip through Rails like before. Cookies
      # are origin-scoped: ours don't go out. No redirect-follow either
      # — navigate / rack_fetch's loop chooses per hop.
      def net_http_fetch(url, env, method: 'GET', body: nil)
        uri = URI.parse(url.to_s)
        Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', open_timeout: 5, read_timeout: 30) do |http|
          req = Net::HTTP.const_get(method.to_s.capitalize).new(uri.request_uri)
          env.each_pair do |k, v|
            next unless k.is_a?(String) && k.start_with?('HTTP_') && k != 'HTTP_COOKIE' && k != 'HTTP_HOST'
            req[k.sub(/\AHTTP_/, '').split('_').map(&:capitalize).join('-')] = v.to_s
          end
          req['Content-Type'] = env['CONTENT_TYPE'] if env['CONTENT_TYPE']
          req.body = body if body && !body.empty?
          resp = http.request(req)
          headers = {}
          resp.each_capitalized {|k, v| (headers[k] ||= []) << v }
          headers = headers.transform_values {|vs| vs.length == 1 ? vs.first : vs.join("\n") }
          [resp.code.to_i, headers, [resp.body || '']]
        end
      rescue SystemExit, Interrupt, NoMemoryError
        raise
      rescue Exception  # WebMock::NetConnectNotAllowedError descends from Exception, not StandardError
        nil
      end

      def merge_set_cookie(headers)
        sc = headers['set-cookie'] || headers['Set-Cookie']
        return if sc.nil? || sc.empty?
        # Rack 2 returns multiple Set-Cookie headers as a single
        # newline-separated string; Rack 3 returns an Array. Treat both
        # uniformly — splitting first means the second cookie in a
        # multi-cookie response (Rails' session cookie alongside the
        # remember_user_token) doesn't get silently dropped.
        lines = sc.is_a?(Array) ? sc : sc.split("\n")
        lines.each {|line|
          parts = line.split(';').map(&:strip)
          pair = parts.shift.to_s
          name, value = pair.split('=', 2)
          next if name.nil? || name.empty?
          if cookie_deletion?(parts)
            @cookies.delete(name.strip)
          else
            @cookies[name.strip] = value.to_s.strip
          end
        }
      end

      # Real browsers treat `Set-Cookie: foo=; Max-Age=0` (or an
      # `Expires=<past>`) as a delete instruction and drop the cookie
      # entirely. ahoy_matey's controller uses this exact pattern to
      # invalidate `ahoy_visit` / `ahoy_visitor` when it decides to
      # mint a new visit. Without honoring the delete, the empty value
      # sits in the jar; the next `getCookie('ahoy_visit')` returns
      # `""` (truthy-ish but useless), and ahoy.js stamps the event
      # with `visit_token: ""` — the server then rejects the POST.
      def cookie_deletion?(attrs)
        attrs.any? {|attr|
          k, v = attr.split('=', 2)
          case k.to_s.downcase
          when 'max-age'
            v.to_s.strip.to_i <= 0
          when 'expires'
            (Time.parse(v.to_s) < Time.now rescue false)
          end
        }
      end

      def stringify(headers)
        out = {}
        headers.each {|k, v| out[k.to_s] = v.is_a?(Array) ? v.join(',') : v.to_s }
        out
      end

      def redirect_location(status, headers)
        return nil unless (300..399).include?(status.to_i)
        headers['location'] || headers['Location']
      end

      def resolve_against_current(url, use_base: false)
        return url if url =~ %r{\A[a-z]+://}i
        base =
          if use_base && (bh = base_href) && !bh.empty?
            # The document's `<base href>` takes precedence over the
            # request URL when the page's own links / form actions are
            # being resolved — HTML's base-tag semantics. `visit` skips
            # this branch so an address-bar navigation reaches the URL
            # the test typed.
            URI.join(@current_url || @default_host, bh).to_s
          else
            @current_url || @default_host
          end
        URI.join(base, url.to_s).to_s
      rescue URI::InvalidURIError, URI::BadURIError
        url
      end

      def base_href
        @runtime.call('__csimBaseHref').to_s
      end

      def carry_fragment(from_url, to_url)
        from = URI.parse(from_url.to_s)
        to   = URI.parse(to_url.to_s)
        return to_url if to.fragment || from.fragment.nil? || from.fragment.empty?
        to.fragment = from.fragment
        to.to_s
      rescue URI::InvalidURIError
        to_url
      end

      # Trace-wrap layer: prepended so the canonical method bodies above
      # stay un-instrumented and a no-trace caller pays only the
      # `record_action` early-exit. `super` forwards to the real impl
      # within the `record_action` block, which handles begin/finish
      # step bookkeeping + on-failure DOM snapshot.
      module RecordedActions
        def visit(url)
          record_action(:visit, "visit #{url}") { super }
        end
        def refresh
          record_action(:refresh, 'refresh') { super }
        end
        def go_back
          record_action(:go_back, 'go_back') { super }
        end
        def go_forward
          record_action(:go_forward, 'go_forward') { super }
        end
        def click(handle, keys = [], **opts)
          record_action(:click, -> { "click #{describe_node_handle(handle)}" }) { super }
        end
        def set_value_with_events(handle, value)
          record_action(:set, -> { "set #{describe_node_handle(handle)} = #{value.inspect[0, 80]}" }) { super }
        end
        def send_keys(handle, keys)
          record_action(:send_keys, -> { "send_keys #{describe_node_handle(handle)} #{keys.inspect[0, 80]}" }) { super }
        end
        def select_option(handle)
          record_action(:select, -> { "select #{describe_node_handle(handle)}" }) { super }
        end
        def unselect_option(handle)
          record_action(:unselect, -> { "unselect #{describe_node_handle(handle)}" }) { super }
        end
        def submit_form(handle)
          record_action(:submit, -> { "submit #{describe_node_handle(handle)}" }) { super }
        end
      end
      prepend RecordedActions
    end
  end
end
