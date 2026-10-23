# frozen_string_literal: true

require 'base64'
require 'date'
require 'digest'
require 'fileutils'
require 'json'
require 'net/http'
require 'openssl'
require 'rack/mock'
require 'securerandom'
require 'set'
require 'socket'
require 'thread'
require 'time'
require 'uri'
require 'zlib'
require_relative 'asset_cache'
require_relative 'errors'
require_relative 'stack_resolver'
require_relative 'trace'
require_relative 'v8_runtime'
require_relative 'webauthn_state'

module Capybara
  module Simulated
    # An asynchronous script that never called its callback in the time Capybara waits (`evaluate_async_script`), as
    # Selenium's and Cuprite's ScriptTimeoutError say of one.
    class ScriptTimeoutError < StandardError; end

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

      # Opt-in: capture each request's author header names verbatim on the Rack env
      # (`csim.raw_request_headers`) so the WPT .py-handler harness can replay them with
      # exact casing / token chars (inspect-headers / echo-headers). OFF for real app
      # traffic — nothing there consumes the list, so it would only allocate per request.
      @@capture_raw_request_headers = false
      def self.capture_raw_request_headers
        @@capture_raw_request_headers
      end
      def self.capture_raw_request_headers=(v)
        @@capture_raw_request_headers = v
      end

      attr_writer :timers_active

      # The Driver's handle for the window this Browser backs (set right after
      # construction). Lets host fns name the source window of a cross-window
      # `postMessage` / `window.open` so the Driver can route to the target.
      attr_accessor :window_handle

      # An about:blank URL: its own document whatever its query or fragment (HTML "matches about:blank").
      ABOUT_BLANK = %r{\Aabout:blank(?:[?#]|\z)}i

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
      # Deterministic virtual-clock model (replaces the old wall-sync, where each
      # tick advanced by REAL wall-elapsed and so coupled virtual time to JS/Ruby/GC
      # speed — a faster `visible_text` shifted WHEN debounces fired, e.g. Avo
      # actions_spec:464). Now each poll advances by a FIXED step; near-future
      # timers on an otherwise-idle page are fast-forwarded to (horizon-gated).
      #
      # 100 ms is empirically the floor that lets a "commit debounce scheduled
      # between two user actions" fire before the next action (Avo actions_spec:464's
      # ~50-75 ms field-commit flips at step 10/50, fixed at >=75). Group-A
      # transient-catch observability does NOT depend on this step — it comes from
      # the `timer_wait_elapsed?` FREQUENCY gate (the first find after an action
      # doesn't tick, so the pre-debounce state is observed regardless of step
      # size), so a larger step completes Group-B without losing Group-A (verified
      # green at 100 across gem 1579, WPT 660, Forem, Avo, :464 passing). Clamped
      # >=1 so a `CSIM_POLL_TICK_STEP_MS=0` misconfig can't freeze the fixed-step path.
      POLL_TICK_STEP_MS = [(ENV['CSIM_POLL_TICK_STEP_MS'] || '100').to_i, 1].max
      # One animation frame (~60 Hz, whole ms — `run_loop_step` truncates). When a
      # poll advances the clock while the page has work runnable NOW (a rAF chain or
      # a timer burst), `tick_real_time` runs the advance in chunks this size so the
      # page's rendering runs at real-browser cadence (one render phase per frame),
      # not one `POLL_TICK_STEP_MS` super-frame — the same model the WPT drain uses.
      FRAME_STEP_MS = 16
      # Per-poll task-iteration cap, mirroring `RuntimeShared#run_loop_step`'s own
      # default — shared across the frame chunks of one poll so sub-stepping keeps
      # the same per-poll ceiling the single-step path had.
      RUN_LOOP_MAX_ITER = 10_000
      # Horizon-gated fast-forward: when the page is observably idle (no timer due
      # now, no background IO) but a timer is parked within this horizon, jump the
      # virtual clock straight to it instead of waiting ~delay/step polls. A timer
      # farther out (ahoy 1000 ms, session-timeout, analytics) is LEFT parked. 600
      # clears every legit must-fire wait (Backburner/DTextField 500, refetch/chart
      # <=200, image-grid 64) while staying BELOW ahoy's 1000. `=0` disables FF →
      # pure deterministic fixed-step (the fallback model).
      FF_HORIZON_MS = (ENV['CSIM_FF_HORIZON_MS'] || '600').to_i
      # Transient guard: hold the page pre-debounce for this many consecutive idle
      # polls before allowing a fast-forward, so "catch the DOM before the 200 ms
      # debounce fires" tests (Discourse refetchForSearch / doubled-filter, Avo
      # filters) still observe the intermediate state across several polls.
      FF_TRANSIENT_GUARD_POLLS = (ENV['CSIM_FF_TRANSIENT_GUARD_POLLS'] || '6').to_i
      # The display the window lives on — the engine's (viewport.rs `SCREEN`), the page's `screen` and
      # its window's first `innerWidth` / `innerHeight`: the window starts filling it, `resize_to` moves
      # the viewport off it, and `maximize` / `fullscreen` restore it.
      SCREEN_SIZE = Native.screen_size.freeze
      SETTLE_DRAIN_MS = 32
      SETTLE_MAX_ITER = 10
      # How long a boot will park for the page's own <img> fetches before letting the window
      # `load` defer to a later drain (see boot_response_into_ctx).
      IMAGE_LOAD_BOOT_BUDGET_S = 0.25
      # How long a session boundary (reset! / dispose) will wait for background
      # app-request threads to finish before abandoning them (see
      # drain_app_request_threads). Generous vs the normal ms-scale request.
      APP_REQUEST_DRAIN_BUDGET_S = 10
      # Per-`run_loop_step` task cap (its `maxIter`). Bounds a self-rescheduling
      # timer/microtask storm so one settle iter returns to Ruby; large enough
      # for the heaviest legit chain (Mastodon hydrate, Turbo stream batch).
      SETTLE_MAX_ITER_TASKS = 256
      # Backstop for the post-boot deferred-external-script drain: a dynamically
      # inserted external <script> runs async (setTimeout 0), so an app's chunk
      # loader chains many of them at boot. We pump only ALREADY-due tasks until the
      # pending count hits 0; this caps a pathological self-injecting loader.
      BOOT_SCRIPT_DRAIN_MAX_ITER = 300
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
      # Sent on every driver-originated Rack call — the engine's (navigator.rs `USER_AGENT`), the page's
      # `navigator.userAgent` too: it leads with `Mozilla/5.0` so server-side bot detectors (ahoy_matey's
      # `Browser.new(ua).bot?`) treat us as a real client. `REMOTE_ADDR` has to be a non-empty, parseable
      # IP — Devise's `trackable` mixin runs `IPAddr.new(request.remote_ip)` during `set_user`/sign-in,
      # and an empty string trips `IPAddr::AddressFamilyError`.
      USER_AGENT = Native.user_agent.freeze
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

      def initialize(app, driver: nil, cookie_jar: nil, auth_cache: nil, local_storage: nil, session_partition: nil, all_hosts_local: nil, client_space: '')
        @app                          = app
        @driver                       = driver
        @all_hosts_local_override     = all_hosts_local
        @runtime                      = V8Runtime.new(self)
        # The wall-sync escape hatch, cached at construction (CLAUDE.md rule 3 — the env is fixed
        # for the session).
        @clock_wall                   = !ENV['CSIM_CLOCK_WALL'].nil?
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
        # The URL the page was at when the current user-action drain began.
        # It's the *starting point* of the action, not an intermediate the
        # action transitioned through, so a pushState/replaceState back to a
        # fresh URL during the drain (a Turbo Drive Visit triggered by the
        # action) must NOT queue it into `@recent_urls` — otherwise a one-shot
        # `current_url` read after the action returns the pre-action URL
        # instead of the navigated-to one (Avo filter `encoded_filters`).
        @action_url_baseline          = nil
        # The URL of the page that navigated to the current document —
        # HTTP `Referer` header on the response that loaded the page,
        # exposed to JS as `document.referrer`. Tracked by `navigate`
        # so post-auth flows (Discourse login: `cookie('destination_url',
        # referrer)` when navigating from `/t/N` → `/login` via link
        # click) can reconstruct the origin URL.
        @current_referer              = ''
        # Cookies are origin-shared in real browsers — the Driver injects
        # the jars so aux windows (per-window VMs) see the same auth state
        # as the primary. Tests without a Driver (gem-internal callers)
        # get fresh jars. (localStorage's shed likewise, below.)
        @cookie_jar                   = cookie_jar    || Native.cookie_jar_new
        # HTTP Basic-auth credential cache, keyed by target origin: once credentials authenticate an
        # origin, the UA sends them pre-emptively for later credentialed requests to it (RFC 7617
        # §2.2), so a Basic-auth resource loads without re-challenging. Session-scoped (cleared on
        # reset) and Driver-injected like the cookie jar, so target=_blank aux windows share one
        # session's auth state (a real browser shares the HTTP auth cache across a session's tabs).
        @auth_cache                   = auth_cache     || {}
        # localStorage and sessionStorage: storage sheds in the engine (storage_areas.rs), an area per storage key
        # (origin and top-level site) — the session's (the Driver's, every window's) and this top-level browsing context's own.
        @local_storage                = local_storage || Native.storage_partition_new
        @local_storage_owned          = local_storage.nil?
        # IndexedDB, Cache Storage and the system clipboard are the session's too: its partition of the engine's
        # registries (idb_databases.rs, cache_storage.rs, system_clipboard.rs), every window's and worker's.
        @session_partition            = session_partition || Native.session_partition_new
        @session_partition_owned      = session_partition.nil?
        # …and the space this window's environment ids are minted in (`sw_client_id`, sw-client.js `clientId`): '' for
        # the session's first window, `w<n>-` for each one after — a context's id unique in the session, whose lock
        # managers (web_locks.rs) every window's realms share.
        @client_space                 = client_space
        @session_storage              = Native.storage_partition_new
        @sticky_headers               = {}
        @timers_active                = false
        # Capybara config is set once per suite; cache the derived
        # origin so the per-request fallback path doesn't re-dispatch
        # `Capybara.app_host` / `server_host` / `server_port` on every
        # rack call (CLAUDE.md: cache env decisions at construction).
        @default_host                 = self.class.default_host
        # The WPT runner serves EVERY host through one in-process Rack app (the
        # wptserve catch-all), so cross-origin test fixtures are genuinely local
        # there. Setting this makes `url_is_local?` true for all hosts, so a
        # cross-origin iframe eager-builds + is served by @app.call directly
        # (no failing net_http_fetch). Apps leave it off: an external embed stays
        # non-local → lazy → no @app.call side effect (extra visit / log row).
        # Universal-server context (every host served in-process → cross-origin frames
        # eager-build). The Driver captures this at session-construction time (when the
        # WPT runner has the env set) and passes it to EVERY window it builds, so an aux
        # window opened LATER — after the runner restored the env — still inherits it.
        # nil override (a stand-alone Browser) falls back to the live env check.
        @all_hosts_local              = @all_hosts_local_override.nil? ? (ENV['CSIM_LOCAL_ALL_HOSTS'] == '1') : @all_hosts_local_override
        # Handle IDs are per-Context integer sequences: a handle from
        # a pre-rebuild context could collide with a fresh node's id
        # in the new context. Node captures this on construction;
        # `check_stale` rejects on mismatch.
        @context_gen                  = 0
        # A document booted whose load-time navigations no driver action's end has taken yet (`take_load_navigations`).
        @load_navigations_due         = false
        @find_cache_dirty             = true
        @find_cache_kind              = nil
        @find_cache_arg               = nil
        @find_cache_ctx               = nil
        @find_cache_value             = nil
        @document_handle              = 0
        # `within_frame` state. `@current_realm_id` is the V8 context id of the
        # active frame realm (nil = the main document); `@frame_stack` records
        # the enclosing realms so `switch_to_frame(:parent)` can pop one level.
        # DOM / node / query ops route through `dom_call`, which dispatches to
        # this realm. nil is the steady state, so the routing is one nil-check.
        @current_realm_id             = nil
        @frame_stack                  = []
        @frame_scope_resets           = 0
        @last_tick_ts                 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        # The first find of a navigation observes the current DOM without a pre-tick (see
        # timer_wait_elapsed?); armed by the first find, disarmed by reset_timer_state.
        @pre_tick_armed               = false
        @read_owes_tick               = false
        @last_read_handle             = nil
        @polling_grace                = nil
        @last_polled_gen              = nil
        @idle_settle_polls            = 0
        @ticking                      = false
        @history                      = []
        @history_idx                  = -1
        # (…and the history a navigation began from, for one that downloads: `download_in_place`)
        @history_before_navigation    = nil
        # The classic history API state the document a reload or traversal makes starts with (replay_history_entry).
        @restoring_history_state      = nil
        @cors_preflight_cache         = {}
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
        # WebSocket — per-Browser handle counter, background frame-reader
        # threads, the csim-side socket end of each connection (for writing
        # client→server frames), and a Queue of lifecycle / message events
        # awaiting delivery into the VM. Same model as SSE: the reader thread
        # does the blocking socket read; the main thread drains the Queue in
        # `settle` and dispatches via `__csim_deliverWebSocketEvents`. The
        # connection rides the in-process `rack.hijack` socket Action Cable
        # (and any Rack WebSocket middleware) takes over.
        # A worker's WebSocket rides the same machinery from its own thread, its reader's events into the worker's inbox
        # (WsWorkerSink) — so the id counter and the registries below are taken under `@websocket_lock`.
        @websocket_seq        = 0
        @websocket_threads    = {}
        @websocket_sockets    = {}   # id → csim's socket end
        @websocket_app_sockets = {}  # id → the app's hijack end (closed on teardown)
        @websocket_workers    = {}   # id → the handle of the worker that opened it (none: the window's)
        @websocket_lock       = Mutex.new
        @websocket_queue      = Thread::Queue.new
        @websocket_queue_head = nil   # one-slot buffer for an event hold_for_ws_close parked ahead of the queue
        # In-flight `ws.close()` handshakes: hold the virtual clock until the reader surfaces the
        # server's echoed close frame (a `__close` event) so a test awaiting `onclose` can't have
        # its virtual-timeout outrun that real off-thread reply. Counted in ws_close, cleared as
        # deliver_websocket_events delivers each terminal event. See hold_for_ws_close.
        @ws_close_pending       = 0
        @ws_close_wait_deadline = nil
        # All frame writes (the reader thread's pong replies + the main thread's
        # send/close) go through one socket; serialise them so two threads can't
        # interleave bytes into a corrupt frame.
        @websocket_write_lock = Mutex.new
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
        # (…each hijacked fetch's URL, credentials mode, cookie context and realm, which its delivery answers by)
        @hijack_fetch_contexts = {}
        # Web Workers — per-Browser handle counter, per-worker
        # {thread, inbox} pair, and a shared outbox the main settle
        # drains via `__csim_deliverWorkerMessages`. Each worker
        # thread owns its own V8 Context (real isolate);
        # cross-isolate messaging is JSON-marshalled.
        @worker_seq    = 0
        @workers       = {}
        @worker_outbox = Thread::Queue.new
        # One-slot head buffer for the settle wait: an event popped while blocking on the outbox
        # is parked here (a push-back would reorder it behind concurrent worker pushes) and
        # consumed first by the next deliver_worker_messages.
        @worker_outbox_head = nil
        # Outstanding posts-to-worker; `polling?` stays true while > 0
        # so long-running compute (e.g. mozjpeg over an 8900×8900 frame)
        # isn't starved by the settle_gen idle gate.
        @worker_in_flight = 0
        # BroadcastChannel posts pushed to worker inboxes that the worker hasn't yet processed. Kept
        # SEPARATE from @worker_in_flight: a broadcast is fire-and-forget (a listen-only worker never
        # replies), so it must not be "answered" by an unrelated postMessage reply. The worker acks
        # each broadcast it delivers (a `bcack` outbox event), which decrements this; `worker_pending?`
        # stays true until then so settle waits for the delivery.
        @worker_broadcast_pending = 0
        # Client → service-worker messages awaiting the worker's ack (it processed the inbound
        # `message`). A SW `postMessage` produces no 1:1 reply (the SW replies via client.postMessage,
        # a separate outbox event), so — like broadcasts — it needs its own pending tally, or a
        # listen-only SW would leave settle perpetually non-idle.
        @sw_message_pending = 0
        # Controlled-client fetches awaiting the SW's respondWith (released by a `fetch_response`).
        @sw_fetch_pending = 0
        # Streaming respondWith bodies still open (head delivered, terminal frame not yet), keyed by
        # the emitting worker handle → the [realm_id, fetch_id] frames it opened. Lets worker_terminate
        # release + error a stream its worker died mid-flight, instead of stranding @sw_fetch_pending.
        @sw_open_streams = Hash.new {|h, k| h[k] = {} }
        # Deadline (CLOCK_MONOTONIC) capping how long the event-loop drain holds the virtual clock
        # for an outstanding SW-side fetch (see run_event_loop_frame). Shared across frames so a
        # stuck fetch costs the budget ONCE, not per frame; reset on each delivered reply so the next
        # fetch in a sequence waits afresh.
        @sw_fetch_wait_deadline = nil
        # Same budget for a pending SW message swack / broadcast ack (drain_pending_message_reply);
        # separate from the fetch deadline so a message wait and a fetch hold don't share a spent
        # budget. Reset once no message/broadcast reply is outstanding.
        @sw_msg_wait_deadline = nil
        # SW navigation-interception state. The session's registrations and service workers live in
        # the engine's registry (sw_registry.rs), partition `@sw_partition`: each registration's
        # versions (which every realm's registration objects read), whether a Register job made it
        # (clients.claim()'s longest-registration-wins check runs against registrations, not
        # workers: a longer scope merely REGISTERED, its first worker still installing, must
        # already shield a client from a shorter scope's claim — claim-not-using-registration
        # "longer-matched"), the worker activating it (Handle Fetch PARKS a functional event
        # against such a registration until activation completes — fetch-waits-for-activate: a
        # frame navigation defers its whole build, see frame_navigation_fetch /
        # __csim_swRetryDeferredNavs, a subresource fetch queues on the worker record, see
        # service_worker_controller_fetch / flush_sw_deferred_fetches), the one serving it (so a
        # navigation fetched Ruby-side — before the destination realm's JS exists — finds its
        # controlling SW), its updateViaCache mode and navigation preload state; and each worker's
        # script URL, type and state.
        # A navigation fetch is awaited SYNCHRONOUSLY on `@sw_nav_outbox` (a dedicated queue, off
        # the general outbox) keyed by a NEGATIVE `@sw_nav_seq` id so it never mixes with
        # client-fetch replies.
        @sw_partition = Native.sw_partition_new
        # True while any realm holds a frame element whose navigation was deferred by an
        # activating registration — the activated marker broadcasts the retry only when set.
        @sw_navs_deferred = false
        # The bytes the Update algorithm just fetched and byte-checked at a scope (`pending_body`,
        # `pending_imports`), consumed by the next service worker_spawn there (the new version must
        # run EXACTLY those bytes, not a re-fetch that could hit the HTTP cache or a newer server
        # response).
        @sw_scope_meta    = {}
        # clients.claim() events that arrived before their scope's worker was active in the registry
        # (activate→claim() races the lifecycle step that makes the worker active) — buffered here, flushed by sw_register_scope.
        @sw_pending_claims = []
        # Unregistered registrations (their numbers) whose Clear Registration is deferred:
        # unregister only unmaps the scope, and the workers live on until no client is using the
        # registration and no extended work is pending (see sw_unregister / try_clear_uninstalls).
        # Each version's lifecycle is stepped here (sw_step), each step a task of its own:
        # `@sw_steps_queued` the workers whose next step is queued, `@sw_step_waits` worker handle →
        # what a worker's lifecycle waits for ('install' / 'activation' — its own phase marker —
        # or 'try_activate'), which resumes it at once.
        # The Register / Update jobs (sw_run_job): `@sw_jobs_queued` the jobs queued to run,
        # `@sw_job_evals` worker handle → the job whose worker it is, settled by its evaluation's
        # outcome, `@sw_jobs_behind` worker handle → the job waiting for that worker's install.
        @sw_pending_uninstalls = []
        @sw_steps_queued       = Set.new
        @sw_step_waits         = {}
        @sw_jobs_queued        = Set.new
        @sw_job_evals          = {}
        @sw_jobs_behind        = {}
        @sw_nav_outbox    = Thread::Queue.new
        # Race-network-and-fetch-handler bookkeeping: [realm, fetch_id] →
        # {resp:, server_ms:, t0:} — the network leg's PRE-FETCHED response (run
        # synchronously on the worker's own thread before the fetch event
        # dispatches), the server's MODELED delay, and the dispatch start. The
        # winner is decided at respondWith time by comparing the modeled server
        # delay against the handler's measured dispatch time — deterministic
        # under any scheduler, where the old first-delivery-wins thread race
        # lost the "server faster" leg whenever a saturated runner starved the
        # leg thread past the handler's 200 ms busy-wait (recurring CI flake).
        # The lock covers main-thread resets racing the worker-thread writes.
        @sw_raced_fetches = {}
        @sw_race_lock     = Mutex.new
        # keepalive_start machinery: detached request results + the 64 KiB
        # in-flight payload quota. Survives per-visit rebuilds by design.
        @keepalive_results  = {}
        @keepalive_inflight_sizes = {}
        @keepalive_inflight = 0
        @keepalive_seq      = 0
        @keepalive_lock     = Mutex.new
        # Async <img> loads: fetch + decode on a thread (a real browser never blocks the parser
        # on an image), delivered into the realm by `deliver_image_loads` from the same drain
        # funnel the other background channels use. Threads are fire-and-forget WITHIN a page's
        # lifetime; the session boundary drains them (see drain_app_request_threads). A result
        # whose element (or realm) is gone is simply dropped at delivery.
        @image_load_seq     = 0
        @image_load_results = {}
        @image_load_flights = {}
        @image_load_pending = 0
        @image_load_lock    = Mutex.new
        # EVERY background thread that runs a Rack request into the host app (async
        # <img> loads, keepalive fetches) registers here via spawn_app_request_thread;
        # drain_app_request_threads joins them at the session boundary — see reset!
        # for the wedge this prevents.
        @app_request_threads = {}
        @app_request_lock    = Mutex.new
        @sw_nav_seq       = 0
        # Reserved-client ids for navigations (`FetchEvent.resultingClientId`): minted once
        # per navigation CHAIN, re-minted when a redirect hop crosses origins (a reserved
        # client is origin-bound — navigation-redirect tags 'a'→'x' across the hop), and
        # ADOPTED by the committed document's realm. The alias maps make the adopted id
        # and the realm resolve to each other (sw_client_id / sw_client_realm), so client
        # records and SW→client message routing keep working under the adopted identity.
        @sw_resulting_seq  = 0
        @sw_client_aliases = {}   # adopted client id → realm id
        @sw_realm_aliases  = {}   # realm id → adopted client id
        # Direct fetch-reply channels for a CONTROLLED WORKER's main-script fetch
        # (worker_main_script_fetch): [sw handle, fetch id] → Queue. The reply bypasses the
        # outbox→main-thread route (the spawning worker's thread parks on the queue), so
        # sw_deliver_fetch_response checks here first. Ids start far above any per-realm
        # fetchSeq so they can never collide with a page fetch on the same worker.
        @sw_direct_lock    = Mutex.new
        @sw_direct_seq     = SW_DIRECT_FID_BASE
        @sw_direct_replies = {}
        # (The service-worker clients — every frame/window and worker client, what a service
        # worker's Clients and an opaque child's inherited controller read — are the engine's
        # registry's, partition `@sw_partition`: sw_note_client. Forgotten when the last worker exits.)
        # The realm holding the focus chain (`note_focused_realm`); nil until a first focus.
        @focused_realm_id    = nil
        # Cross-isolate MessagePort channels: each end's holder and the messages waiting for one
        # (`port_end_here`). Cleared with the workers.
        @port_ends           = {}
        # Workers whose initial script hasn't finished running yet. A worker that
        # posts immediately on spawn (no main->worker message first) would leave
        # `@worker_in_flight` at 0, so `worker_pending?` would be false in the gap
        # between spawn and that first post — and settle / tick_real_time would
        # stop waiting before the message lands. Count spawned-but-not-initialised
        # workers so the async drain holds until the initial script has run.
        @worker_initializing = 0
        # Worker threads actively PROCESSING a plain postMessage (dequeued, not yet back at
        # the idle poll). `@worker_in_flight` counts posted messages minus delivered replies,
        # but one request yields MANY replies (progress updates + the final resolve), so it
        # under-counts to 0 mid-handshake and `worker_pending?` would go false while the worker
        # is still working — settle then breaks and abandons a multi-round protocol
        # (Tesseract's createWorker load→loadLanguage→initialize→recognize, each a round-trip
        # gated on a slow synchronous WASM step). The SW / broadcast message kinds have their
        # own pending counters, so only the postMessage branch bumps this. Held under
        # @worker_init_lock alongside @worker_initializing.
        @worker_busy = 0
        @worker_init_lock = Mutex.new
        # This window's blob URL registry, the engine's (blob_registry.rs): what the blob URLs its contexts — its realms,
        # its workers' isolates, which see none of the page isolate's store (blob_urls.rs) — made resolve to, each
        # revoked as the context that made it goes; and the copies of a blob: document's booted here.
        @blob_window = Native.blob_window_new(@session_partition)
        # Postmessage transferable-buffer store. Large Uint8Array /
        # ArrayBuffer payloads cross isolates as a Ruby-side byte ID
        # rather than a JSON base64 string, so peak JS heap stays flat.
        @transfer_buffer_lock = Mutex.new
        @transfer_buffers     = {}
        @transfer_buffer_seq  = 0
        # (family, weight/style) -> the fontconfig file native text metrics read. Misses cache as nil, so an
        # unresolved family asks fontconfig once, not once per measurement.
        @font_table_lock      = Mutex.new
        @font_files           = {}
        @fc_strong_lock       = Mutex.new
        @fc_strong_families   = {}
        # Zero-copy postMessage transfer tokens (rusty_racer
        # `RustyRacer.transferOut`): a buffer in a `postMessage` transfer list
        # crosses isolates by token (no byte copy), its source detached. A token
        # parked but never imported pins its backing store PROCESS-WIDE, so we
        # record every issued token (reported from JS, possibly on a worker
        # thread — hence the lock) and `transferDrop` the lot on `reset!`
        # (idempotent: an already-imported token no-ops).
        @transfer_tokens      = []
        @transfer_tokens_lock = Mutex.new
        # Cross-window `postMessage` inbox. Another window's `target.postMessage`
        # routes through the Driver and lands here; this window drains it into a
        # `message` event the next time it's active and settles/ticks. Plain
        # array (same thread — windows aren't background-threaded like workers).
        @window_inbox         = []
        # Cross-window BroadcastChannel messages from OTHER windows, delivered to
        # this window's matching channels on settle. [{name, data}] (same thread).
        @broadcast_inbox      = []
        # Storage `storage` events queued for the OTHER documents of the area's storage key (a
        # change fires at every one EXCEPT the one that made it), delivered on settle.
        # [{kind, key, old, new, url, area, targets}] (same thread).
        @storage_inbox        = []
        # BroadcastChannel's global ordered delivery queue (the multi-realm path — see bc_post): the FIFO of pending
        # {realm_id, id, data, origin} deliveries, each to a channel of the isolate's registry (broadcast_channels.rs)
        # in creation order, drained in order by deliver_window_messages.
        @bc_queue             = []
      end

      # Max BroadcastChannel deliveries drained per `deliver_broadcast_queue` call — a safety bound on a
      # pathological mutual re-post loop (see there). Far above any real fan-out (the ordering test is ~14).
      BROADCAST_DRAIN_CAP      = 100_000

      # Worker thread polling and termination intervals — split so a
      # tuning change to one doesn't accidentally rebind the other.
      WORKER_POLL_INTERVAL     = 0.05
      # Direct-reply fetch ids (sw_direct_fetch) live far above any per-realm fetchSeq.
      SW_DIRECT_FID_BASE       = 1_000_000_000
      # Max wall time settle blocks on a worker thread's outbox per call while it processes an
      # inbound message / fetch (releasing the GVL so it runs). Bounded so a genuinely stuck worker
      # can't hang settle — the outer poll loop re-drives across calls.
      WORKER_ROUND_TRIP_BUDGET = 1.0
      WORKER_TERMINATE_GRACE   = 0.05
      # Max rounds `drive_worker_to_quiescence` runs before yielding back to the poll loop.
      # A message handler's async bring-up (Emscripten WASM init) settles in a handful of
      # microtask / 0 ms timer rounds; the cap only bites a worker that keeps rescheduling
      # a due timer, which the poll loop then continues to advance.
      WORKER_QUIESCE_MAX_ROUNDS = 256
      # Per-frame GVL yield (run_event_loop_frame) while a worker thread is alive, so it gets a clean
      # slice for cross-isolate work (transferIn / message replies) instead of being starved by the
      # phase-1 spin. 0.3ms is the empirical floor for a deterministic cross-isolate transfer reply;
      # 0.5ms adds margin for machine variance while staying cheap (only paid on worker/SW files).
      WORKER_GVL_YIELD         = 0.0005
      # Client-realm handler for each streaming respondWith frame kind (see deliver_worker_messages
      # + sw-client.js). `fr_start` builds a ReadableStream-backed Response; `fr_chunk` enqueues;
      # `fr_close` / `fr_error` close / error the body stream.
      # A worker's MessagePort channel signals about an END — handled in the order the worker sent them, ahead of its
      # port messages (deliver_worker_messages).
      PORT_END_KINDS = %w[port_here port_gone port_closed port_redeliver].freeze
      STREAM_FRAME_FNS = {
        'fr_start' => '__csim_swFetchStreamStart',
        'fr_chunk' => '__csim_swFetchStreamChunk',
        'fr_close' => '__csim_swFetchStreamClose',
        'fr_error' => '__csim_swFetchStreamError'
      }.freeze
      private_constant :WORKER_POLL_INTERVAL, :WORKER_ROUND_TRIP_BUDGET, :WORKER_TERMINATE_GRACE, :WORKER_GVL_YIELD, :WORKER_QUIESCE_MAX_ROUNDS, :PORT_END_KINDS, :STREAM_FRAME_FNS

      # ── Capybara DSL surface ────────────────────────────────────

      # Address-bar navigation: no Referer, and relative paths resolve
      # against the host root (not the current page's directory).
      # `initiator:` is the document that caused this top-level navigation (the
      # OPENER for a window.open'd window) — it seeds the navigation's
      # Sec-Fetch-Site, which the cookie layer's SameSite gate reads. A plain
      # driver-initiated visit has none (address-bar semantics, site 'none').
      def visit(url, referer: nil, referrer_policy: nil, initiator: nil)
        # Explicitly nil for a driver-initiated visit (address-bar semantics, site
        # 'none') — page-initiated internal callers reach `navigate` directly and
        # inherit its @current_url default.
        navigate(resolve_visit_url(url), referer: referer, referrer_policy: referrer_policy, initiator: initiator)
        # The native state of what earlier pages left unreachable freed, as a settle frees it (see the pump there): a
        # suite that only visits and reads never settles. A page's own FinalizationRegistry callbacks run here too, as a
        # browser runs them as tasks — and they may change the page.
        @runtime.pump_message_loop
        @find_cache_dirty = true
      end

      # The navigation of the page a document planned as it loaded — its location set, a form submitted, a link followed,
      # by its parse, its `load` handlers or the tasks its load ran — taken as the driver's action that loaded it ends (a
      # visit, a click, a submit, a refresh, a traversal: `RecordedActions`), as a browser starts it then: a matcher that
      # reads only the URL or the text (`have_current_path`, `has_text?`) takes none, and an auto-submitting page (an
      # OAuth `form_post`) stayed put. Due where a document booted since (`@load_navigations_due`), the one it navigates
      # to booting the next; bounded as a load handler's chain is. (A `window.open` of the load opened its window as the
      # load ran; a link's or a form's to a new window is opened here as any of its plans is.)
      def take_load_navigations
        WINDOW_LOAD_CHAIN_MAX.times do
          break unless @load_navigations_due

          @load_navigations_due = false
          consume_pending_location
          consume_pending_page_submission
          consume_pending_navigation
          consume_pending_form_submit
        end
      end

      def resolve_visit_url(url)
        s = url.to_s
        # `about:blank` (and other authority-less schemes) have no `//`, so the
        # `scheme://` test below would treat them as relative paths and prepend
        # the host root. `navigate` handles `about:blank` specially — pass it
        # through untouched (open_new_window opens an about:blank tab).
        return s if s.match?(/\Aabout:/i)
        unless s =~ %r{\A[a-z]+://}i
          # Strip path/query/fragment off the current URL to get the origin
          # root. An opaque or host-less current URL (e.g. `about:blank` in a
          # freshly-opened window) can't yield an origin — fall back to the
          # default host so a subsequent relative `visit` still resolves.
          current   = parse_url(@current_url.to_s)
          host_root = current && !current[:host].empty? ? url_root(current) : @default_host.sub(/\/+$/, '')
          s = "/#{s}" unless s.start_with?('/')
          s = "#{host_root}#{s}"
        end
        # …parsed as the page parses a URL (the URL Standard's parser, url_ops.rs): what it percent-encodes is what that
        # URL's position takes — a space in a path, not a `|` in a query, which an RFC 3986 escape had encoded
        # (`?include=(Document|Window)` reached the page as `(Document%7CWindow)`). A URL it does not parse is left
        # as written, for the navigation to fail on.
        parse_url(s)&.fetch(:href) || s
      end

      URL_PARTS = %i[href protocol username password host hostname port pathname search hash origin].freeze
      # The parts of the URL `input` parses to, by the page's parser (url_ops.rs) — or nil where it does not parse.
      # A redirect's `Location` parsed against the URL of the response that carries it (Fetch "HTTP-redirect fetch":
      # "location URL" — relative or not, the URL parser's), or the header as it is where it parses as none.
      def resolve_location(loc, url)
        parse_url(loc, url.to_s)&.fetch(:href) || loc
      end
      def parse_url(input, base = nil)
        parts = Native.url_parts(url_text(input), base && url_text(base))
        parts && URL_PARTS.zip(parts).to_h
      end

      # A URL string as the parser takes it, text: one handed over as bytes (a Location header's, binary-tagged or no
      # UTF-8) its UTF-8 where it is that, else each byte past ASCII percent-encoded as itself — what Chrome makes of a
      # Location that is no UTF-8 (`\xFF` → `%FF`: fetch/api/redirect/redirect-location-escape).
      def url_text(s)
        return s unless s.is_a?(String) && !(s.encoding == Encoding::UTF_8 && s.valid_encoding?)

        utf8 = s.b.force_encoding(Encoding::UTF_8)
        return utf8 if utf8.valid_encoding?

        s.b.gsub(/[\x80-\xFF]/n) {|byte| format('%%%02X', byte.ord) }.force_encoding(Encoding::UTF_8)
      end

      # A URL's scheme, credentials and host — what a path is resolved under.
      def url_root(url)
        credentials = url[:username].empty? ? '' : "#{url[:username]}#{":#{url[:password]}" unless url[:password].empty?}@"
        "#{url[:protocol]}//#{credentials}#{url[:host]}"
      end

      # A URL string split at its fragment: the URL before it, and the fragment (nil where it has none, '' where it is
      # empty — `x#` is not `x`).
      def split_fragment(url)
        base, fragment = url.split('#', 2)
        [base, fragment]
      end

      # A Ruby URI for a URL a socket is opened to (EventSource, a real host's fetch): Ruby's parser takes only a
      # URI-legal copy of what the URL Standard keeps.
      def uri_for(url)
        URI.parse(url.to_s.sub(/#.*/m, '').b.gsub(RACK_URI_ILLEGAL) {|c| format('%%%02X', c.ord) })
      end

      # Queued URLs older than this (real wall clock) are treated as
      # stale and dropped on the next `current_url` read. Capybara's
      # default polling interval is 50 ms, so a `have_current_path`
      # walk runs through its iterations well under this threshold;
      # a `page.current_url` read between unrelated user actions
      # arrives long after the prior action's settle pushed
      # intermediates, falls past the cutoff, and surfaces the
      # current URL directly. The window is generous because the age
      # it measures includes the gap between the action's own drain
      # (which pushes the entries) and the matcher's FIRST read —
      # under full-suite load that gap blew past a 250 ms window and
      # a `have_current_path` right after a save-click missed the
      # committed intermediate it was asserting on. The primary
      # staleness signal is the next user action, which clears the
      # queue outright (`mark_action_baseline`); this age is the
      # backstop for action-less reads long after the fact.
      RECENT_URLS_STALE_AGE_MS = 2000

      # The last committed top-level URL with NO event-loop tick — `current_url`
      # pumps `tick_real_time`, so calling it re-entrantly from inside a host-fn
      # callback (the driver building an aux window mid-`window.open`) corrupts
      # the caller's parse/event-loop state. Use this for identity reads.
      def raw_current_url = @current_url.to_s

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
        # The URL the action started from is the starting point, not an
        # intermediate it walked through — don't surface it to a polling
        # (or one-shot) `current_url` as a step. Genuine mid-action
        # intermediates (a load to /wizard, *then* a replaceState to
        # /wizard/steps/setup) differ from the baseline and still queue.
        return if @action_url_baseline && old.to_s == @action_url_baseline.to_s
        @recent_urls << old.to_s
        @recent_urls.shift while @recent_urls.size > 8
        @recent_urls_last_push_at = Process.clock_gettime(Process::CLOCK_MONOTONIC, :millisecond)
      end

      attr_reader :current_realm_id

      # DOM / node / query host-fn dispatch. Inside a `within_frame` block it
      # routes to the active frame realm's context; otherwise straight to the
      # main context. Handle integers are per-realm (each realm is a full
      # bridge with its own registry), so an op on a frame node must run in the
      # realm the handle came from — which, per Capybara's within_frame
      # contract, is the current realm for the block's duration. Hot path:
      # `@current_realm_id` is nil outside frames, so this is one nil-check over
      # a direct `@runtime.call`.
      def dom_call(name, *args)
        return @runtime.call(name, *args) if @current_realm_id.nil?
        # The active frame's realm was torn down mid-block (the iframe was
        # removed or re-navigated). Surface a stale element so Capybara
        # retries / reports, rather than letting realm_call fall back to the
        # main context where this frame handle would mis-resolve.
        unless @runtime.frame_realm_alive?(@current_realm_id)
          raise Capybara::Simulated::StaleElement,
            "frame browsing context #{@current_realm_id} was torn down (frame removed or re-navigated)"
        end
        @runtime.realm_call(@current_realm_id, name, *args)
      end

      # Root for a context-less find: the active frame's document (handle 0 ⇒
      # the realm's own `globalThis.document`) when in a frame, else the main
      # document handle.
      def current_document_handle
        @current_realm_id ? 0 : @document_handle
      end

      # Capybara `switch_to_frame`. `target` is an `<iframe>` handle in the
      # CURRENT realm, or `:parent` / `:top`. Entering builds (or reuses) the
      # frame's V8 realm and routes subsequent DOM ops there; `:parent` pops one
      # level, `:top` returns to the main document. Frame switches invalidate
      # the find cache (its keys aren't realm-qualified, and a switch is rare).
      #
      # Scope: finds, reads, interactions (click/fill_in/…), evaluate_script,
      # and navigation (a link / form submit whose default action loads a new
      # document) all route into the frame — the target frame's realm is rebuilt
      # from the fetched document, leaving the top page untouched (see
      # `navigate_frame` / `frame_nav_target_entry`). A `_parent`-targeted link
      # or form from a frame nested ≥2 levels rebuilds the intermediate parent
      # frame; `_top` (and a one-level `_parent`, whose parent is the top
      # context) navigate the main page. Cross-origin frame locality is resolved
      # against the main page's origin.
      def switch_to_frame(target)
        invalidate_find_cache
        case target
        when :parent
          @frame_stack.pop
          @current_realm_id = @frame_stack.last && @frame_stack.last[:realm_id]
        when :top
          reset_frame_scope
        else
          parent_realm = @current_realm_id
          tick_real_time
          rid = dom_call('__csimEnsureFrameRealm', target.to_i).to_i
          if rid.zero?
            raise Capybara::Simulated::StaleElement,
              "could not enter frame ##{target} (not a frame element, or its document failed to load)"
          end
          # Record the iframe handle + the realm it lives in so a frame-scoped
          # navigation can rebuild this exact frame (`reload_current_frame_realm`).
          @frame_stack.push({realm_id: rid, iframe_handle: target.to_i, parent_realm_id: parent_realm})
          @current_realm_id = rid
          # Let the freshly built realm's inline scripts / load handlers settle
          # so a find immediately inside the block sees the loaded document.
          settle
        end
      end

      # Return DOM-op routing to the main document and drop any frame stack.
      # Called by `switch_to_frame(:top)`, per-test `reset!`, and every full
      # page (re)build (which disposes all frame realms) — anything that
      # invalidates the active `within_frame` scope.
      def reset_frame_scope
        @current_realm_id = nil
        @frame_stack.clear
        @frame_scope_resets += 1
      end

      # `yield`ed as the main document's, whichever frame a `within_frame` has entered — a step of its own that the
      # scope would route to the frame (the top document's form serialized in its realm, its target resolved from the
      # top) — and the scope back as it was, unless a full page build dropped it meanwhile.
      def in_top_context
        return yield if @current_realm_id.nil? && @frame_stack.empty?

        realm, stack, resets = @current_realm_id, @frame_stack.dup, @frame_scope_resets
        reset_frame_scope
        begin
          yield
        ensure
          if @frame_scope_resets == resets + 1
            @current_realm_id = realm
            @frame_stack.replace(stack)
          end
        end
      end

      # The active browsing context's own URL: the frame document's URL inside
      # a `within_frame` block, else the main page URL. Used to resolve a
      # frame-relative navigation and to set its request referrer, so
      # `resolve_against_current` / `pure_fragment_navigation?` work the same
      # whether the navigation originates in the main page or a frame.
      def current_browsing_context_url
        return @current_url unless @current_realm_id
        href = dom_call('__csimLocationHref').to_s
        href.empty? ? @current_url : href
      end

      # Public entry for the Driver to resolve a `window.open` / cross-window
      # `location` URL against THIS window's document (the internal resolver is
      # private). Honours `<base href>` like the page's own links do.
      def resolve_document_url(url)
        resolve_against_current(url, use_base: true)
      end

      # The keywords a navigable target name is (navigables.rs `target_keyword`, ASCII case-insensitive).
      TARGET_NAME, TARGET_SELF, TARGET_TOP, TARGET_PARENT, TARGET_BLANK = 0, 1, 2, 3, 4
      def target_keyword(target) = Native.target_keyword(target.to_s)

      # Does a link/form `target` load into the CURRENT frame? Empty or `_self`
      # do; `_top` / `_blank` / `_parent` / a named context do not.
      def frame_self_target?(target) = target_keyword(target) == TARGET_SELF

      # Resolve a link/form `target` to the frame stack entry its navigation
      # should rebuild, or nil when it targets the top page / a new context
      # (the caller then falls through to a full-page `navigate` or aux window).
      # Only meaningful inside a frame (`@current_realm_id` set):
      #   - `''` / `_self` → the current frame.
      #   - `_parent` → the intermediate parent frame, but only when nested ≥2
      #     levels deep; at one level the parent IS the top browsing context, so
      #     it returns nil and the full-page path handles it (same as `_top`).
      def frame_nav_target_entry(target)
        return nil unless @current_realm_id
        return @frame_stack.last if frame_self_target?(target)
        return @frame_stack[-2] if target_keyword(target) == TARGET_PARENT && @frame_stack.size >= 2
        nil
      end

      def find_css(css, context_handle = nil)
        s = css.to_s
        return find_xpath(s, context_handle) if xpath_shaped?(s)
        find_with_timer_fallback(:css, s, context_handle) do
          dom_call('__csimQuery', context_handle || current_document_handle, s).to_a
        rescue StandardError => e
          # Invalid selector → empty result. Callers that genuinely
          # need the throw go through `evaluate_script`.
          raise unless invalid_selector_error?(e)
          []
        end
      end

      def find_first_css(css, context_handle = nil)
        s = css.to_s
        find_with_timer_fallback(:css_first, s, context_handle) do
          h = dom_call('__csimQueryOne', context_handle || current_document_handle, s).to_i
          h.zero? ? nil : h
        rescue StandardError => e
          raise unless invalid_selector_error?(e)
          nil
        end
      end

      # JS-side selector parser throws a `DOMException('csim: …',
      # 'SyntaxError')`, which V8 surfaces as a `RustyRacer::RuntimeError`
      # whose message is `"SyntaxError: csim: …"`. Match the `csim: ` marker
      # anywhere in the message (it's no longer at the start once the
      # DOMException name is prefixed).
      def invalid_selector_error?(e)
        e.is_a?(RustyRacer::RuntimeError) && e.message.include?('csim: ')
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

      # XPath is evaluated natively over the arena (xpath.rs, through
      # `document.evaluate`). One IPC per `find_xpath` — no serialise + reparse
      # round-trip.
      def find_xpath(xpath, context_handle = nil)
        xpath_str = xpath.to_s
        find_with_timer_fallback(:xpath, xpath_str, context_handle) do
          dom_call('__csimEvaluateXPath', xpath_str, context_handle || 0).to_a
        end
      end

      def find_with_timer_fallback(kind, arg, ctx)
        # OUTSIDE the timer gate below: a page with no active timer never ticks, and a
        # server-rendered page that wires itself up on `load` is exactly that page — it
        # would have answered every `find` / `has_css?` from a document whose load had
        # never fired, while `page.html` showed the handler's work. One ivar test.
        flush_pending_window_load
        # A read since the last query owes the clock a step — pay it here, where
        # moving the clock can't strand a snapshot mid-walk (`tick_for_read`).
        settle_read_debt
        tick_real_time if timer_wait_elapsed?
        # After the first find of a navigation, a later find IS Capybara retrying — arm the pre-tick
        # so subsequent polls advance the clock (a timer-driven element / removal the test awaits).
        @pre_tick_armed = true
        result = cached_find(kind, arg, ctx) { yield }
        # An empty result is the wait-for-it case: Capybara is retrying for
        # an element that hasn't appeared yet. Re-tick so the next poll
        # observes anything an active timer OR a background-IO channel
        # (Worker / EventSource / a held long-poll publish) is about to
        # deliver. Gating on `@timers_active` alone misses the held-poll
        # case — a MessageBus subscription waiting on a cross-session
        # publish has NO pending JS timer (the re-poll only schedules after
        # the current poll returns), so `@timers_active` is false while
        # `hijack_fetch_pending?` is true. Without `async_io_pending?` here
        # the delivered message never reaches the DOM during find-polling
        # (only `evaluate_script`, which ticks unconditionally, would see
        # it). Non-empty results keep the fast path — no extra tick.
        return result unless empty_find_result?(result) && (@timers_active || async_io_pending?)

        tick_real_time
        return result unless @find_cache_dirty

        cached_find(kind, arg, ctx) { yield }
      end

      def empty_find_result?(result)
        result.nil? || (result.respond_to?(:empty?) && result.empty?)
      end

      # Minimum wall-clock gap before find() re-ticks, so a burst of finds in one
      # poll iteration doesn't advance the clock once each. (It used to also carry
      # "the first find returns the DOM before a `setTimeout(0)` runs"; the page's
      # own init now runs with the LOAD, where a browser runs it — see
      # `flush_page_init`.) Keep this above one Ruby boundary so a single visit+find
      # pair
      # doesn't accidentally tick.
      FIND_PRE_TICK_MIN_S = 0.05
      # Whether a find should advance the clock BEFORE reading the DOM. The FIRST find after a
      # navigation observes the current (pre-timer) DOM unconditionally — the "query the DOM before
      # advancing pending timers" contract — so it never pre-ticks; only a LATER find (Capybara
      # retrying because the element wasn't there yet) does, gated on the tick FREQUENCY. Anchoring
      # the first-find exemption on a flag (not the wall clock) keeps it deterministic: a >50 ms wall
      # gap between the navigation and the first find under full-suite load must NOT fire a parked
      # setTimeout(0) the page just scheduled (smoke_spec "queries the current DOM …").
      # NOTE: the same first-find contract after a USER ACTION (click/fill) is still gated only on the
      # 50 ms wall clock — @pre_tick_armed is disarmed by reset_timer_state (navigation) alone. Actions
      # keep the wall gate because the post-action pre-tick timing is tuned against the debounce-
      # between-actions app cases (Avo actions_spec:464); no action-path flake has surfaced there.
      def timer_wait_elapsed?
        @pre_tick_armed &&
          @timers_active &&
          (Process.clock_gettime(Process::CLOCK_MONOTONIC) - @last_tick_ts) >= FIND_PRE_TICK_MIN_S
      end

      # What a READ (`text` on an already-found node) does to the clock.
      #
      # It can't advance it on every read. `all(…).map(&:text)` walks N elements of
      # ONE query, back to back — in a browser no page time passes between them — and
      # a step per read walked the clock into the re-render those reads were racing,
      # detaching the rest of the snapshot. Capybara can't recover from that: `all`
      # hands back elements with `allow_reload: false`, so its retry re-reads the same
      # dead nodes (Discourse `tags_spec:221`).
      #
      # It can't stop advancing it either. A read is the driver's heartbeat while a
      # matcher polls: `assert_text` re-reads its node without going back through
      # `find`, and for a node that can't be reloaded — anything from `all` / `first`,
      # or any node when `Capybara.automatic_reload` is off — no find will ever run,
      # so the page would sit still until the wait expired.
      #
      # The two are told apart by WHICH node is read:
      #
      #   the same handle again  → a matcher polling its node → advance now
      #   a different handle     → the next element of a walk → owe it, and let the
      #                            next query pay (`settle_read_debt`), where moving
      #                            the clock can't strand a snapshot mid-walk
      #
      # (The page's own `setTimeout(0)` init doesn't depend on a read at all —
      # `flush_page_init` runs it with the load, which is where a browser runs it.)
      def tick_for_read(handle)
        repeat            = @last_read_handle == handle
        @last_read_handle = handle
        return tick_real_time if repeat

        @read_owes_tick = true
      end

      # Pay what a read since the last query owes (see `tick_for_read`).
      def settle_read_debt
        return unless @read_owes_tick

        tick_real_time
      end

      # Cheap O(1) gate: is there any non-timer async channel with traffic
      # that `tick_real_time` would drain? `tick_real_time` itself runs
      # exactly when this (plus `@timers_active`) holds, and each of these
      # predicates is a single `.empty?` / counter check. Reusing them
      # here lets an attribute poll whose value is delivered only by a
      # Worker / SSE / hijacked-fetch message (with no active timer) still
      # drain that channel, without paying an unconditional drain on
      # timer-driven runloop pages.
      def async_io_pending?
        worker_pending? || event_source_pending? || hijack_fetch_pending? || window_message_pending? || websocket_pending? || image_loads_pending? || agent_notices_pending?
      end

      # The engine registries' notices (agents.rs — IndexedDB's, Web Locks') for this window's realms, taken — each realm
      # its own, as its next event loop step would — and for the session's other windows: an auxiliary window's event loop
      # runs only as the active window's does, and a `versionchange` it never fires would hold every other window's
      # upgrade, a lock it is never granted every request queued after it.
      def deliver_agent_notices
        return 0 unless Native.agent_notices_pending(@session_partition)

        agent_windows.sum {|b| b.deliver_own_agent_notices(background: !b.equal?(self)) }
      end

      # …and, for a window that is not the active one, the tasks they queue that are due — a lock granted it, whose
      # callback is a task of its own — run here (`maxMs: 0`), as a background tab's would: what its callback releases
      # reaches the window waiting for it, which the active window's loop does not otherwise step.
      def deliver_own_agent_notices(background: false)
        return 0 unless @runtime.call('__csimAgentsPending')

        @runtime.call('__csimAgentDeliver')
        @runtime.frame_realm_ids.each {|rid| @runtime.realm_call(rid, '__csimAgentDeliver') }
        if background
          r = @runtime.run_loop_step(0, SETTLE_MAX_ITER_TASKS, yield_on_gen: false)
          @find_cache_dirty = true if r['dirtied'] || r['fired'].to_i > 0
        end
        1
      end

      # Whether a registry owes a realm of one of the session's windows a notice another realm's or a worker's call caused
      # (engine-notices.js `deliver`). The session's check first, which costs no V8 call.
      def agent_notices_pending? = Native.agent_notices_pending(@session_partition) && agent_windows.any? {|b| b.runtime_agent_notices_pending? }

      def runtime_agent_notices_pending? = @runtime.call('__csimAgentsPending') == true

      # (…this window first, then the session's others)
      private def agent_windows = [self, *(@driver&.window_browsers || []).reject {|b| b.equal?(self) }]

      # Single-slot cache for the most recent find_xpath / find_css /
      # find_first_css result. Capybara's `synchronize` retry loop
      # re-issues the same find on every poll while waiting for an
      # element to appear or disappear; if no DOM-mutating event has
      # happened since the last call (no timer fired, no click / set /
      # navigate), the result is guaranteed identical and we can skip
      # the V8 round-trip + the XPath evaluation.
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

      def text(handle)        = dom_call('__csimText', handle).to_s
      def tag(handle)         = dom_call('__csimTag', handle).to_s
      def attr(handle, name)  = dom_call('__csimAttr', handle, name.to_s)
      def inner_html(handle)  = dom_call('__csimInnerHTML', handle).to_s
      def outer_html(handle)  = dom_call('__csimOuterHTML', handle).to_s
      def file_input?(handle)
        tag(handle) == 'input' && attr(handle, 'type').to_s.downcase == 'file'
      end
      def visible?(handle)    = dom_call('__csimVisible', handle) ? true : false
      # `obscured?` — coarse occlusion / hit-test in JS (layout.js). Non-visible / out-of-viewport /
      # click-point-lands-on-another-element → obscured.
      def obscured?(handle)   = dom_call('__csimObscured', handle) ? true : false
      # `rect` — the element's coarse border-box from the layout engine, as the full 8-field box.
      # Two key styles on purpose: Capybara's spatial `Rectangle` reads STRING keys
      # (`position['top']`); Discourse's `wait_for_animation` reads the SYMBOL key (`rect[:x]`).
      def rect(handle)
        r = dom_call('__csimRect', handle)
        x = (r['x'] || 0).to_f
        y = (r['y'] || 0).to_f
        w = (r['width'] || 0).to_f
        h = (r['height'] || 0).to_f
        {
          x:, y:, width: w, height: h, top: y, left: x, bottom: y + h, right: x + w,
          'x' => x, 'y' => y, 'width' => w, 'height' => h, 'top' => y, 'left' => x, 'bottom' => y + h, 'right' => x + w
        }
      end
      # `scroll_to` — drive a real scroll offset in the layout engine (layout.applyScrollTo). `target`
      # is a target element's handle (or nil); `pos` a keyword (`:top`/`:bottom`/`:center`); `x`/`y`
      # an explicit coordinate. Symbols are stringified for the JS side.
      def scroll_to(handle, target = nil, pos = nil, x = nil, y = nil)
        dom_call('__csimScrollTo', handle, target, pos&.to_s, x, y)
        nil
      end

      # Capybara's `scroll_to(:current, offset: [dx, dy])` routes here — a scroll relative to the
      # element's current offset, clamped to its scrollable range like a browser does.
      def scroll_by(handle, dx, dy)
        tick_real_time
        ensure_alive_after_tick(handle)
        dom_call('__csimScrollBy', handle, dx.to_f, dy.to_f)
        settle
      end

      # Capybara::Driver::Node surface — Node calls `check_stale`
      # before each read, and that advances the virtual clock.
      def all_text(handle)     = text(handle)
      def visible_text(handle) = dom_call('__csimVisibleText', handle).to_s
      def tag_name(handle)     = tag(handle)
      def value(handle)        = dom_call('__csimValue', handle)
      def disabled?(handle)    = dom_call('__csimDisabled', handle)
      # HTML spec: `<option>.selected` IDL is true when the `selected`
      # *attribute* is set OR when no sibling option has `selected` and
      # this is the first non-disabled option of a single-select
      # `<select>` (implicit default). Capybara's `have_select(selected:
      # "Choose an option")` filter calls `selected?` on each option;
      # without the implicit-default branch, a select with no explicit
      # `<option selected>` reports no selected options and the matcher
      # fails even though the first option *is* the currently chosen
      # one in real browsers.
      def option_selected?(h)  = !!dom_call('__csimOptionSelected', h)
      def shadow_root_handle(handle)
        h = dom_call('__csimShadowRoot', handle).to_i
        h.zero? ? nil : h
      end
      def computed_style(handle, names)
        tick_real_time
        result = dom_call('__csimComputedStyle', handle, names.map(&:to_s))
        return names.to_h {|n| [n, ''] } unless result.is_a?(Hash)
        result.transform_keys(&:to_s)
      end
      def node_path(handle)    = dom_call('__csimNodePath', handle).to_s

      def lookup_node(handle)
        handle if dom_call('__csimAlive', handle)
      end

      def check_stale(handle, initial, gen = nil)
        return if initial && (gen.nil? || gen == @context_gen) && dom_call('__csimAlive', handle)

        tick_real_time
        return if initial && (gen.nil? || gen == @context_gen) && dom_call('__csimAlive', handle)

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
        return if dom_call('__csimAlive', handle)
        raise Capybara::Simulated::StaleElement, "Element with handle #{handle} is no longer attached to the document"
      end

      def click(handle, keys = [], **opts)
        mark_action_baseline
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
            partial = dom_call('__csimClickResolve', handle, init, {'interceptCheck' => true})
            # An intercepted click never dispatched its mousedown — surface it
            # here rather than letting clickFinish fire the up/click half against
            # the covered target.
            # (…and the release is the press's own: the page holds what it pressed, `__csimClickFinish`)
            if !partial.is_a?(Hash) || partial['kind'] != 'partial'
              partial
            else
              sleep delay
              dom_call('__csimClickFinish')
            end
          else
            dom_call('__csimClickResolve', handle, init, {'interceptCheck' => true})
          end
        unless action.is_a?(Hash)
          settle
          # Drain the download intent the click chain may have queued.
          # Avo's action-download path: form submit → Turbo applies a
          # turbo-stream → `StreamActions.download` → file-saver's
          # `saveAs` → `setTimeout(() => click(<a download>), 0)` →
          # our dispatchEvent default-action sets
          # its planned download (navigation_plan.rs). Settle bails on the first
          # observable change (the stream-render mutation), so the
          # await-chain inside the stream's `connectedCallback`
          # (`await nextRepaint(); await performAction()` →
          # `setTimeout(click(a), 0)`) hasn't reached saveAs yet —
          # nudge it forward with a few alternating microtask /
          # timer drain rounds, then consume directly. (Can't route
          # via `tick_real_time`: post-drain `@timers_active` is
          # false and it bails before its own consume_pending_*
          # drains.)
          # Most clicks don't queue any timers; bail as soon as a
          # round drains nothing rather than burning the full 8 engine
          # round-trips. Profile (Avo actions_spec / V8): the
          # unconditional loop cost ~7.7 % of wall time.
          8.times do
            @runtime.drain_microtasks
            break if @runtime.drain_timers(50).to_i.zero?
          end
          # …and what those left to do, inside the click action: Discourse's `lib/click-track.js` preventDefaults link
          # clicks and routes navigation through `DiscourseURL.redirectTo → window.location = href` (an attachment's
          # download), and a timer may follow a link or submit a form.
          drain_task_intents
          return
        end
        case action['kind']
        when 'intercepted'
          # Nothing was dispatched — the click point is covered by an unrelated
          # element. Retryable (invalid_element_errors): Capybara re-finds and
          # re-clicks until the obstruction goes away, as with a real driver.
          raise Capybara::Simulated::ClickIntercepted,
                "element click intercepted: #{action['target']} is not clickable at point " \
                "(#{action['x']}, #{action['y']}); other element would receive the click: #{action['other']}"
        when 'navigate'
          url = action['url'].to_s
          target = action['target'].to_s
          # Inside a frame, a frame-targeted link (self, or `_parent` of a
          # ≥2-deep frame) navigates that FRAME, not the top page: fetch +
          # rebuild its realm. A self-targeted pure-fragment link is already
          # handled in-realm by the frame's own location JS, so skip it.
          if (frame_entry = frame_nav_target_entry(target))
            unless frame_entry.equal?(@frame_stack.last) && pure_fragment_navigation?(url, use_base: true)
              tick_real_time
              navigate_frame(resolve_against_current(url, use_base: true), entry: frame_entry)
            end
          # `target="_blank"` (or any non-_self/_top/_parent name) opens
          # in a new browsing context (its own Browser/VM); the primary
          # stays put (per HTML spec — original window is unaffected), with the
          # opener the link's noopener leaves it (`action['opener']`), as the
          # scripted click / dispatchEvent activation paths do.
          elsif new_window_target?(target)
            open_hyperlink_window(
              resolve_against_current(url, use_base: true),
              target:      target,
              opener:      action['opener'],
              link_policy: action['referrerPolicy'],
              blob:        action['blob']
            )
          # In-page anchor links (`#frag` / current-page + `#frag`) move
          # the hash but don't fetch a new document. Pure-fragment also
          # short-circuits the `<a>`s test fixtures use as click sinks.
          elsif pure_fragment_navigation?(url, use_base: true)
            update_current_hash(resolve_against_current(url, use_base: true))
          else
            # Drain any work the click handler queued before the VM gets
            # rebuilt — analytics libraries (Ahoy / segment / GA) queue
            # the event into a setTimeout-driven flush and rely on the
            # browser firing it before navigation tears their context
            # down. Without this drain the tracking POST is lost on
            # every internal link click.
            tick_real_time
            # Link clicks honour `<base href>` (HTML spec); `visit`
            # does not — that's address-bar navigation. (…a `blob:` one's blob the one it was clicked with, a revoke by
            # a handler of the click no matter)
            navigate_top_from_page(resolve_against_current(url, use_base: true), blob: host_blob(action['blob']))
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
          8.times do
            @runtime.drain_microtasks
            break if @runtime.drain_timers(50).to_i.zero?
          end
          # If the drain queued or consumed a `location.assign`, that
          # navigation supersedes the form's default submit. Honour
          # pending; if `@current_url` already changed mid-drain (the
          # navigate landed during a timer fire), skip the form submit
          # entirely — its form handle is in a stale VM by now.
          consume_pending_frame_nav
          if @pending_location
            consume_pending_location
          elsif @current_url != submit_baseline_url
            # Already navigated; nothing more to do.
          else
            submit_form_spec(action['spec'])
          end
        when 'download'
          save_download(action['url'].to_s, action['filename'].to_s)
        end
      end

      def download_link(url, filename_hint = '')
        env = rack_env_for(url, method: 'GET')
        env['HTTP_USER_AGENT'] = @default_user_agent || USER_AGENT
        env['REMOTE_ADDR']     = self.class.remote_addr_for(env['HTTP_HOST'] || env['SERVER_NAME'])
        ck = cookie_header_for(env_request_url(env), secure: env_secure_channel?(env))
        env['HTTP_COOKIE']     = ck              unless ck.empty?
        referrer               = referrer_header(@current_url)
        env['HTTP_REFERER']    = referrer if referrer
        response = dispatch_rack_or_http(url, env) or return
        status, headers, body = response
        return unless status.to_i == 200
        # Fall back to the link's `download="filename"` value or the
        # URL path tail when Content-Disposition is absent — `<a download>`
        # is the spec hook for naming a download independently of the
        # response headers.
        forced_headers = headers.dup
        if content_disposition_header(forced_headers).to_s.empty?
          name = filename_hint.empty? ? File.basename(parse_url(url.to_s)&.fetch(:pathname).to_s) : filename_hint
          forced_headers['Content-Disposition'] = %(attachment; filename="#{name}") unless name.empty?
        end
        save_downloaded_response(url, forced_headers, body)
      end

      # HTML "navigate": a navigation to `url` is one to a fragment of the current document where `url` has a fragment
      # (`#` too — `location.hash = ''` gives one) and equals the document's URL but for their fragments (url_ops.rs) —
      # `url` as written resolved against the document's URL, or, a link's (`use_base`), against its base URL, where an
      # `<a href="#x">` under `<base href="/other/">` goes to another document.
      def pure_fragment_navigation?(url, use_base: false)
        doc_url = current_browsing_context_url
        !doc_url.nil? && Native.url_fragment_navigation(doc_url.to_s, resolve_against_current(url, use_base: use_base).to_s)
      end

      def update_current_hash(url)
        return if @current_url.nil?
        new_url = resolve_against_current(url)
        @current_url = new_url
        # JS-driven same-document fragment navigations (anchor clicks AND
        # `location.hash`/`href`/`assign` sets) are now handled entirely in
        # the VM by `tryFragmentNavigate` — they update the JS location and
        # fire `hashchange` there and never round-trip through here. This
        # path remains only as a defensive fallback for a fragment URL that
        # reaches the Ruby navigate/pending drain by some other route; keep
        # the VM's location object in sync so its `location.href` getter
        # doesn't read stale.
        @runtime.call('__csimUpdateLocation', new_url)
      end

      def set_value_with_events(handle, value)
        mark_action_baseline
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        case dom_call('__csimInert', handle)
        when 'click'
          raise Capybara::Simulated::ClickIntercepted, "element click intercepted: #{describe_node_handle(handle)} is inert"
        when 'keys'
          raise Capybara::Simulated::ElementNotInteractable, "element not interactable: #{describe_node_handle(handle)} is inert"
        end
        # `attach_file` hands us a Pathname (or Array of Pathnames);
        # the marshaller rejects non-primitive types. Coerce to a path-list
        # form V8 can hold — the actual multipart upload happens later
        # in `form_request` during form submission.
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
          # (…keyed by the handle as an Integer, as the reads look it up: a frame's handle arrives a Float, which
          # a Hash keeps apart from the Integer it equals)
          @file_picks[handle.to_i] = paths
          # Expose File-list metadata to the JS side BEFORE setting the
          # value: __csimSetValue fires input + change synchronously,
          # and Redmine's onchange="addInputFiles(this)" reads
          # `inputEl.files` — if we set files after, the handler sees
          # an empty FileList and tears down the input.
          dom_call('__csimSetFiles', handle, paths.map {|p| picked_file(p) })
          # Mirror real browser: <input type=file>.value reflects only
          # the filename of the first chosen file (security-faked path).
          # __csimSetValue dispatches input + change synchronously.
          js_value = paths.first ? picked_file_name(paths.first) : ''
          dom_call('__csimSetValue', handle, js_value)
        else
          dom_call('__csimSetValue', handle, coerced)
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
        (@file_picks && @file_picks[handle.to_i]) || []
      end

      # JS-side `__HostBackedFile.text()` / `arrayBuffer()` route through
      # this to read attached file bytes on demand — ActiveStorage's
      # `DirectUpload` MD5-chunks the file via FileReader before
      # POSTing to `/rails/active_storage/direct_uploads`. Returns
      # the requested byte range as a BINARY String, which reaches JS
      # as a Uint8Array.
      def read_file_pick(handle, index, start = nil, finish = nil)
        paths = file_picks_for(handle)
        path = paths && paths[index.to_i]
        return nil unless path && File.exist?(path)
        size = File.size(path)
        s = [start.to_i, 0].max
        e = finish.nil? ? size : [finish.to_i, size].min
        return ''.b if e <= s
        File.open(path, 'rb') do |f|
          f.seek(s)
          f.read(e - s) || ''.b
        end
      end

      # WebDriver's obscured-click refusal, shared by the click chains that don't
      # route through `__csimClickResolve`. Raises the retryable error so
      # Capybara re-finds and re-clicks once the overlay is gone.
      private def raise_if_click_intercepted(handle, init)
        r = dom_call('__csimClickInterceptedAt', handle, init)
        return unless r.is_a?(Hash) && r['kind'] == 'intercepted'
        raise Capybara::Simulated::ClickIntercepted,
              "element click intercepted: #{r['target']} is not clickable at point " \
              "(#{r['x']}, #{r['y']}); other element would receive the click: #{r['other']}"
      end

      def right_click(handle, keys = [], **opts)
        mark_action_baseline
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        init = click_event_init(handle, keys, opts)
        raise_if_click_intercepted(handle, init)
        # The press retargets to what the point hits; the release is
        # over the same element.
        pressed = dom_call('__csimContextPress', handle, init)
        sleep opts[:delay].to_f if opts[:delay].to_f > 0
        dom_call('__csimContextRelease', pressed, init) if pressed.to_i > 0
      end

      # A file the user picked from disk, as the JS side builds its File:
      # name, size, type and modification time.
      def picked_file(path)
        stat = (File.stat(path) rescue nil)
        {
          'name'         => picked_file_name(path),
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
          'type'         => mime_type_for_path(path),
          'lastModified' => stat ? (stat.mtime.to_f * 1000).to_i : 0
        }
      end

      # …its name, text: a path of raw bytes read as the UTF-8 a file system
      # names it in, a byte that is none (or a path's in another encoding that
      # does not convert) a U+FFFD.
      def picked_file_name(path)
        name = File.basename(path)
        name = name.force_encoding('UTF-8') if name.encoding == Encoding::BINARY
        name.encode('UTF-8', invalid: :replace, undef: :replace)
      end

      # HTML5 drag-and-drop simulation. Capybara routes `Element#drop`
      # here with a flat list of paths / Pathnames / Hashes: a drag
      # from outside the page released over the element. Its files are
      # a pick of their own, read like an `attach_file`'s — keyed below
      # zero, where no element's handle is.
      def drop(handle, args)
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        items = args.flat_map {|arg| drop_items(arg) }
        @drops = (@drops || 0) + 1
        pick   = -@drops
        (@file_picks ||= {})[pick] = items.select {|i| i['kind'] == 'file' }.map {|i| i['path'] }
        dom_call('__csimDropOnto', handle, items, pick)
      end

      # Element-to-element drag. Capybara's `Element#drag_to(target,
      # drop_modifiers:, html5:, delay:)` lands here; the sequencing lives
      # in `drag.js` (pointer-driven vs HTML5, decided from the source's
      # mousedown). `drop_modifiers` are held down from `dragenter` on, the
      # way a user pressing a key mid-drag produces. `delay` is a
      # real-browser pacing knob — our dispatch is synchronous, so the page
      # sees each step in order without it. Discourse sidebar reorder + Avo
      # Sortable-shaped widgets read `event.offsetY` to decide "above vs
      # below"; we report 0, which routes drops above the target.
      def drag_to(source_handle, target_handle, html5: nil, drop_modifiers: [], **_opts)
        mark_action_baseline
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(source_handle)
        ensure_alive_after_tick(target_handle)
        # Staged with a settle between each step: a real drag spans several frames, and libraries
        # use that gap (SortableJS applies its ghost class from a `setTimeout` scheduled in
        # `dragstart` and never reaches its reorder logic if `dragover` lands in the same turn).
        # This is what the reference driver's `delay:` between steps buys.
        dom_call('__csimDragBegin', source_handle, target_handle,
                 {'html5' => html5, 'modifiers' => modifier_flags(drop_modifiers)})
        settle
        dom_call('__csimDragMove')
        settle
        dom_call('__csimDragFinish')
        drain_after_user_action
      end
      def drop_items(arg)
        case arg
        when Hash
          arg.map {|type, value| {'kind' => 'string', 'type' => type.to_s, 'value' => value.to_s} }
        when ->(x) { x.respond_to?(:to_path) }
          [{'kind' => 'file', 'path' => arg.to_path, 'file' => picked_file(arg.to_path)}]
        when String
          [{'kind' => 'file', 'path' => arg, 'file' => picked_file(arg)}]
        else
          []
        end
      end

      def double_click(handle, keys = [], **opts)
        mark_action_baseline
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        init = click_event_init(handle, keys, opts)
        raise_if_click_intercepted(handle, init)
        # UI Events spec: two full mousedown→mouseup→click chains, the
        # second's count 2, before the trailing `dblclick`. Jspreadsheet
        # (table-builder's `.jss_worksheet`) enters edit mode on the inner
        # mousedown.
        [1, 2].each {|detail| dom_call('__csimClickResolve', handle, init.merge('detail' => detail)) }
        # A browser selects the word during the SECOND press's default action, so
        # the selection is already in place when `dblclick` fires — ProseMirror's
        # double-click handling reads the selection at event time, and selecting
        # only afterwards let PM commit its own narrower word first (its anchor
        # then survived the late correction: the paste-URL-over-selection test
        # wrapped `**bold**` but not the adjacent `` `code` `` span).
        dom_call('__csimSelectWordAt', handle)
        dom_call('__csimDblClick', handle, init)
        settle
      end

      MODIFIER_KEYS = {
        shift:    'shiftKey',
        control:  'ctrlKey',
        ctrl:     'ctrlKey',
        alt:      'altKey',
        option:   'altKey',
        meta:     'metaKey',
        command:  'metaKey',
        cmd:      'metaKey'
      }.freeze
      MODIFIER_KEY_NAMES = MODIFIER_KEYS.keys.to_set.freeze
      def modifier_flags(keys)
        Array(keys).each_with_object({}) {|k, h|
          field = MODIFIER_KEYS[k.is_a?(Symbol) ? k : k.to_sym]
          h[field] = true if field
        }
      end

      # Resolve the click point against the element's laid-out box — the
      # same geometry `rect` / `obscured?` / `drag_to` and the page's own
      # `getBoundingClientRect` read, so a click lands where the page
      # believes the element is. `opts[:offset] == :center` means x/y are
      # relative to the element's centre (Capybara's w3c_click_offset
      # semantics); otherwise they're relative to its top-left, so the
      # point is the element's own origin plus the offset — including the
      # 8px body margin a real page has (confirmed in Chrome).
      #
      # This is exactly what the unified geometry buys: Capybara's own
      # click-offset fixture logs `event.clientX - this.getBoundingClientRect()
      # .left`, which only comes back as the requested offset when the
      # pointer we synthesize and the rect the page measures come from the
      # same layout. They are not the same BOX, though: WebDriver measures
      # its in-view centre point on the element's first client rect, which
      # for an inline that wrapped is its first fragment, not its bounding
      # box — whose centre is the paragraph text between its two lines.
      def click_event_init(handle, keys, opts)
        out = modifier_flags(keys)
        has_xy = opts[:x] || opts[:y]
        center = opts[:offset] == :center || !has_xy
        if has_xy || center
          rect = dom_call('__csimPointerRect', handle)
          base_x = rect['x'].to_f + (center ? rect['width'].to_f  / 2.0 : 0.0)
          base_y = rect['y'].to_f + (center ? rect['height'].to_f / 2.0 : 0.0)
          out['clientX'] = base_x + opts[:x].to_f
          out['clientY'] = base_y + opts[:y].to_f
        end
        out
      end

      def hover(handle)
        mark_action_baseline
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        # Set `document._hoverElement` so `:hover` pseudo-class matches
        # resolve against this element (Redmine's gantt tooltips +
        # context-menu submenus rely on CSS `:hover`). The host fn
        # call into `__csimSetHover` does the slot update on the JS
        # side AND fires the hover events (`mouseover` / `mouseenter`
        # where the hovered element changed, the moves) — keeping the
        # state-set and dispatch on the same path avoids the
        # double-eval recursion the inlined `globalThis.document.
        # _hoverElement = ...` triggered (the eval string ran inside
        # a fresh microtask that re-entered the hover listeners).
        dom_call('__csimSetHover', handle)
      end

      def dispatch_event(handle, type, init = {})
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        dom_call('__csimDispatchEvent', handle, type.to_s, init)
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
        mark_action_baseline
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
        if has_multichar_text && dom_call('__csimIsContentEditable', handle)
          per_char = atoms.flat_map {|a|
            next a unless a['kind'] == 'text' && a['value'].to_s.length > 1
            a['value'].to_s.each_char.map {|c| {'kind' => 'text', 'value' => c} }
          }
          head, *tail = per_char
          dom_call('__csimSendKeys', handle, [head])
          tail.each {|atom|
            tick_real_time
            dom_call('__csimSendKeys', handle, [atom])
            settle
          }
        else
          dom_call('__csimSendKeys', handle, atoms)
        end
        drain_after_user_action
      end

      def select_option(handle)
        mark_action_baseline
        tick_real_time
        invalidate_find_cache
        dom_call('__csimSelectOption', handle)
        tick_real_time
        drain_after_user_action
      end

      def unselect_option(handle)
        mark_action_baseline
        tick_real_time
        invalidate_find_cache
        # Single-select <select>s can't have a selection cleared per
        # HTML — Capybara surfaces this as `UnselectNotAllowed`. Ask
        # the JS side whether the option's parent select is `multiple`
        # before issuing the unselect; the answer doubles as the
        # "found the right ancestor" check.
        info = dom_call('__csimOptionContext', handle)
        if info.is_a?(Hash) && info['hasSelect'] && !info['multiple']
          raise Capybara::UnselectNotAllowed, 'Cannot unselect option from single select box.'
        end
        dom_call('__csimUnselectOption', handle)
        tick_real_time
        drain_after_user_action
      end

      # Read the form-submit pending intent set by JS-side
      # `form.submit()` / `form.requestSubmit()`. Called by user-action
      # entry points (click is the primary, but a `<select onchange="$
      # ('#form').submit()">` pattern reaches here through
      # select_option). Without this hop the planned submission (navigation_plan.rs)
      # is never taken and the form never actually navigates / POSTs.
      def consume_pending_form_submit
        pending = @runtime.call('__csimTakePendingFormSubmit')
        return unless pending.is_a?(Hash)
        # (…the main document's plan, which a frame's submission is routed past: its form submitted as that document's)
        in_top_context { submit_form_spec(pending) }
      end

      # Pin the URL the page is at as a user action BEGINS — the FIRST line of
      # every action entry (click / double_click / right_click / hover / set /
      # send_keys / select / unselect). A Turbo Drive Visit the action triggers
      # is async — its pushState may fire synchronously mid-action or in a LATER
      # find-poll tick (the test's `wait_for_loaded`) — so `record_url_transition`
      # uses this baseline to recognise the pre-action URL as the action's
      # starting point, not a walkable intermediate, and skip queuing it. Set at
      # action entry (NOT the tail drain, which runs after the pushState); must
      # precede the action's first `tick_real_time` so a deferred prior-page
      # timer firing in that tick is still measured against the pre-action URL.
      # Persists until the next action (so the async case is covered) and is
      # reset by `navigate` so a stale baseline can't leak across a document
      # boundary.
      def mark_action_baseline
        @action_url_baseline = @current_url
        # A NEW user action makes the previous action's intermediate-URL chain
        # stale outright — whatever a poller didn't walk by now belongs to a
        # story that is over. This, not the wall-clock age (which only backstops
        # action-less late reads), is the primary bound on the queue's lifetime.
        @recent_urls.clear if @recent_urls
        # A user action re-arms the polling grace directly: its consequences can
        # arrive through channels `polling?` cannot see yet — a streaming
        # websocket message still on the server's side (Mastodon posts a status,
        # the home-timeline update rides the stream a beat later). The grace used
        # to be armed only by a settle-gen bump observed WHILE @timers_active —
        # which the action's own settle usually provided incidentally — so a page
        # that went fully idle the instant the action finished left `wait?` false
        # and Capybara's very next matcher ran single-shot, racing the stream. A
        # real driver never stops waiting; this keeps ours polling for a bounded
        # window after every action while an untouched idle page still fails fast.
        @polling_grace     = POLLING_GRACE_POLLS
        @idle_settle_polls = 0
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
        @runtime.drain_timers(USER_ACTION_DRAIN_MS) if @timers_active
        # (…and what the tasks that drain ran left to do: a timer's `link.click()` / `form.submit()`)
        drain_task_intents
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
        settle_idle_style
        start_gen = @runtime.settle_gen
        prev_gen  = start_gen
        worker_wait_deadline = nil
        SETTLE_MAX_ITER.times do
          deliver_event_source_events
          deliver_worker_messages
          deliver_hijacked_fetches
          deliver_window_messages
          deliver_websocket_events
          deliver_image_loads
          deliver_agent_notices
          break if @runtime.settle_gen > start_gen
          break unless @timers_active || async_io_pending?
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
          deliver_window_messages
          deliver_websocket_events
          deliver_image_loads
          deliver_agent_notices
          break if @runtime.settle_gen > start_gen
          # A background worker thread owes us a CONTRACTUAL reply (a swack / bcack /
          # fetch_response is posted under `ensure`, so it always comes) but hasn't posted it
          # yet. With no timer, `run_loop_step(0)` returns instantly, so busy-spinning the
          # remaining iterations would STARVE the worker thread of the GVL and it would never
          # process its inbox. Block briefly on the outbox instead: this releases the GVL (the
          # worker runs) and wakes the instant it posts. The popped event is parked in
          # (via `park_worker_reply`, which parks it in `@worker_outbox_head` — NOT pushed back,
          # which would reorder it behind anything the worker enqueued in the meantime — so the next
          # deliver drains it first). The budget is shared across the whole settle call, and
          # exhausting it bails to Capybara's outer poll loop — a genuinely stuck worker must not pin
          # every find's settle for SETTLE_MAX_ITER budgets. Gated on `worker_reply_pending?`, NOT
          # `worker_pending?`: `@worker_in_flight` (plain postMessage — a listen-only worker never
          # replies) and `@worker_initializing` have no matching reply, and blocking on them would
          # tax every settle on such pages with the full budget.
          if worker_reply_pending? && @worker_outbox.empty? && @worker_outbox_head.nil?
            worker_wait_deadline ||= Process.clock_gettime(Process::CLOCK_MONOTONIC) + WORKER_ROUND_TRIP_BUDGET
            park_worker_reply(worker_wait_deadline) while worker_reply_pending? &&
              @worker_outbox.empty? && @worker_outbox_head.nil? &&
              Process.clock_gettime(Process::CLOCK_MONOTONIC) < worker_wait_deadline
            next if @worker_outbox_head || !@worker_outbox.empty?
            break
          end
          # No progress this iter (no DOM/URL change observed) — the
          # remaining timers are queued for the future; bail and let
          # Capybara's wall-clock-driven poll loop drive the next tick
          # via `tick_real_time`. SSE / Worker channels keep us in
          # the loop as long as background threads have data queued.
          break if @runtime.settle_gen == prev_gen && !@runtime.has_ready_timer? && !async_io_pending?
          # Only in-flight image loads keeping us here? Yield the GVL briefly so their fetch
          # threads (~20 ms each) can finish inside this settle instead of a later poll —
          # spinning empty zero-budget loop steps would starve exactly the thread we wait on.
          sleep 0.005 if image_loads_pending? && !@timers_active && !@runtime.has_ready_timer?
          prev_gen = @runtime.settle_gen
        end
        # Free the native state of what the settle's churn left unreachable — a CSSOM rule's or sheet's, a
        # TextDecoder's: pump the foreground message loop so V8's FinalizationRegistry cleanup callbacks
        # run (cssom.js, cascade.js, encoding.js). A no-op when nothing was collected. (A DOM node's slot
        # is freed by its handle, at the next node made — node_handle.rs.)
        #
        # The pump drains ALL pending foreground platform tasks (and runs a microtask checkpoint). This
        # driver models timers/promises on its own virtual-clock queues, NOT V8's platform queue, so the
        # only foreground tasks are FR cleanup callbacks: the driver's own are pure native frees (ruleDrop,
        # sheetDrop, textDecoderClose — no DOM mutation, no microtask), but a PAGE's FinalizationRegistry
        # callback is app code, which may mutate the DOM and queue microtasks — those land here, after the
        # settle quiesced, for the next poll to observe (a browser runs them as tasks, at no set time either).
        @runtime.pump_message_loop
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
        # (…the main document's plan: its hyperlink's href resolved against it, whichever frame `within_frame` entered)
        in_top_context { follow_pending_hyperlink(pending) }
      end
      # A hyperlink's new window (HTML "follow the hyperlink" with a target that names none): named by its target but
      # for `_blank` — a second link of the name navigates the window the first opened — with the opener `opener` says
      # (token_list.rs `noopener`), and loaded with its document's URL as the referrer (steps 8-9), under the policy its
      # `rel` / `referrerpolicy` set (`link_policy`: '' for its document's) — the document of realm `realm_id`'s.
      def open_hyperlink_window(url, target:, opener:, link_policy:, blob: nil, realm_id: @current_realm_id.to_i)
        referrer, document_policy = realm_referrer_initiator(realm_id)
        @driver.open_aux_window(
          url,
          name:             target_keyword(target) == TARGET_BLANK ? nil : target.to_s,
          source:           self,
          activation_realm: realm_id,
          opener:           !!opener,
          blob_snapshot:    blob,
          referrer:         referrer || '',
          referrer_policy:  link_policy.to_s.empty? ? document_policy : link_policy.to_s
        )
      end

      def follow_pending_hyperlink(pending)
        url    = pending['url'].to_s
        target = pending['target'].to_s
        if new_window_target?(target)
          # (…`opener` the link's noopener's answer; open_aux_window forces noopener anyway for a cross-partition blob)
          open_hyperlink_window(
            resolve_against_current(url, use_base: true),
            target:      target,
            opener:      pending['opener'],
            link_policy: pending['referrerPolicy'],
            blob:        pending['blob']
          )
        elsif pure_fragment_navigation?(url, use_base: true)
          update_current_hash(resolve_against_current(url, use_base: true))
        else
          tick_real_time
          navigate_top_from_page(resolve_against_current(url, use_base: true), blob: host_blob(pending['blob']))
        end
      end

      # `<a download>` clicked synthetically (file-saver's saveAs ships
      # a freshly-created anchor through `dispatchEvent(MouseEvent
      # 'click')`). The click's default action plans `{url, filename}` as a
      # download (navigation_plan.rs); we drain
      # here at every tick so the file lands in `downloads_directory`
      # before Capybara's `wait_for_download` polls.
      def consume_pending_download
        pending = @runtime.call('__csimTakePendingDownload')
        return unless pending.is_a?(Hash) && pending['url']
        save_download(pending['url'].to_s, pending['filename'].to_s)
      end

      # A download's resource saved to `downloads_directory`: a `blob:` URL's bytes from the page, anything else fetched.
      def save_download(url, filename)
        if url.start_with?('blob:')
          content = @runtime.call('__csimReadBlobBytes', url)
          return if content.nil?
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
        form_handle = dom_call('__csimAncestorForm', handle).to_i
        return if form_handle.zero?
        # (…none its document's sandbox refuses: `form.submit()`'s steps, which this one's are)
        return if dom_call('__csimFormSubmissionRefused', form_handle)
        submit_form_spec(dom_call('__csimFormSerialize', form_handle, 0))
      end

      def title
        tick_real_time
        @runtime.call('__csimDocumentTitle').to_s
      end

      # The differences CSIM_ARENA_VERIFY=1 found between this browser's trees and their arena copies since the last
      # call (the spec harness asks at a session's end).
      def take_arena_verify_failures = @runtime.take_arena_verify_failures

      # `page.html` inside a `within_frame` block returns the frame document's
      # source (Selenium parity), so route through the active realm.
      def html
        tick_real_time
        dom_call('__csimDocumentHtml').to_s
      end

      # The trace's screenshot: the painted page as a data URL, or nil if anything at all went
      # wrong. Deliberately silent — a trace step with no image is a smaller loss than a suite that
      # fails while recording why it failed.
      #
      # Refuses once this browser's trace has been handed over (`@trace` nil, `@pending_trace` set
      # by `reset!`): the page has been rebuilt by then, so what there is to paint is the BLANK one
      # the reset installed. A host that persists after its own teardown — Minitest's
      # `after_teardown` chain — would otherwise store that white rectangle as "the state the
      # failing example ended in", which is worse than storing nothing.
      def trace_screenshot
        return nil unless @trace

        png = screenshot_png(tick: false)
        png && "data:image/png;base64,#{[png].pack('m0')}"
      rescue StandardError
        nil
      end

      # PNG bytes for the current page, painted from the layout the driver already holds
      # (js/src/paint.js). Routed through the active realm like `html`, so a screenshot taken
      # inside a `within_frame` block shows that frame.
      # `tick`: a page-facing screenshot advances the clock like any other read, but one taken to
      # RECORD what happened must not — a trace is an observer.
      def screenshot_png(full: false, tick: true)
        tick_real_time if tick
        out = dom_call('__csimScreenshot', full)
        return nil unless out.is_a?(Hash) && out['refId']

        # The painter wrote the PNG (natively) and stashed it here, returning an id for it.
        transfer_buffer_fetch(out['refId'])
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
      # Whether the page is cross-origin isolated (`cross_origin_isolated_response?`, as its document committed) — which its
      # workers are too.
      def cross_origin_isolated? = @runtime&.cross_origin_isolated == true
      # …which a pop-up its opener keeps takes from it, ahead of its initial about:blank document (`boot_response_into_ctx`).
      def inherit_cross_origin_isolation(opener) = (@runtime.cross_origin_isolated = opener.cross_origin_isolated?)
      # …and the origin and base URL of the document that opened it, which its about:blank document takes (HTML "create a
      # new browsing context": the creator's origin), the next one the window boots — an opaque one none: a separate VM
      # has no way to share its key, and a new opaque origin is what it would be otherwise.
      def inherit_creator(origin:, base:)
        @creator = {origin: origin.to_s, base: base.to_s} unless origin.to_s.empty? || origin.to_s.start_with?('null')
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
      attr_reader :default_viewport, :default_user_agent, :session_partition, :client_space
      # Whether the session's pointer is a touchscreen (the driver's `touch:`), told every document as it boots.
      attr_accessor :touch_input

      def default_viewport=(vp)
        @default_viewport = vp
        set_viewport(*vp) if vp
      end

      def default_user_agent=(ua)
        @default_user_agent = ua
        @runtime.user_agent_changed(ua) if ua && @runtime
      end

      def set_viewport(w, h)
        @viewport_width  = w.to_i
        @viewport_height = h.to_i
        invalidate_find_cache
        # One slot for the viewport (the engine's, viewport.rs): `innerWidth` / `innerHeight` are
        # `[Replaceable]` accessors over it, and the `@media` cascade and the layout engine read it
        # directly. Every live frame's content box moves with it — a frame lays out against its
        # container — handed on by the resize steps below.
        @runtime.eval_void("globalThis.__csimSetViewport(#{@viewport_width}, #{@viewport_height});")
        # Recompute the cascade `@media` rules against the new
        # viewport so visibility checks (Capybara `visible?`,
        # `getComputedStyle().display`) re-reflect mobile-breakpoint
        # `display: none` / `display: block` flips. Without this the
        # style engine keeps the pre-resize media answers.
        @runtime.call('__csimRebuildCascade') if @document_handle.to_i > 0
        # …and the resize steps, now rather than at the next rendering update, which a page with
        # nothing scheduled never runs: the window's `resize`, its `matchMedia` listeners' `change`s
        # (Discourse's viewport-based mobile/desktop class swap), then each frame's whose container
        # the new size moved.
        @runtime.call('__csimResizeSteps') if @document_handle.to_i > 0
        nil
      end
      def viewport_width                  ; @viewport_width  || SCREEN_SIZE[0] ; end
      def viewport_height                 ; @viewport_height || SCREEN_SIZE[1] ; end
      # What `maximize` / `fullscreen` restore. A driver configured with a viewport is a mobile
      # session (`default_viewport`, the same channel `reset!` uses to keep it mobile across
      # resets), and maximizing must not silently promote it to desktop — its "display" is the
      # viewport it was built with.
      def screen_size                     ; @default_viewport || SCREEN_SIZE ; end
      # Capybara-initiated `page.go_back` runs from Ruby, not inside a
      # JS call, so it's safe to rebuild the Context synchronously. The
      # `force:` flag bypasses the deferral that `history_go` uses to
      # avoid terminating the running JS context.
      def go_back        ; history_go(-1, force: true) ; end
      def go_forward     ; history_go(+1, force: true) ; end

      # Reset the session history to empty WITHOUT the full `reset!` (cookies /
      # storage / viewport / frame scope stay put). A single session that visits
      # many documents in sequence — the WPT conformance runner reuses one for
      # the whole 1645-file suite — otherwise accumulates every prior visit's
      # history entry, so a document that calls `history.back()` (e.g. a bfcache
      # round-trip test) traverses the SHARED history back into the PREVIOUS
      # document and re-runs it. Clearing history per visit confines each
      # document's back / forward to its own navigations, matching a real
      # browser's fresh-browsing-context isolation, so results don't depend on
      # visit order. Not wired into `visit` itself — a normal session keeps
      # cross-`visit` back-navigation (Selenium parity); only callers that want
      # per-document isolation invoke it.
      def reset_history!
        @history.clear
        @history_idx               = -1
        @history_before_navigation = nil
        @pending_history_traverse  = nil
      end

      # Move through the history stack by `delta`. Per HTML spec, a
      # same-document traversal (within a chain of pushState entries
      # rooted at a single navigation) updates `location` and fires
      # `popstate` with the entry's state — no full reload. A cross-
      # document traversal replays the entry (full navigate / re-POST).
      # Returns the traversal kind so a cross-window caller
      # (`window_history_go`) knows whether to fire the target window's
      # deferred `load`: `:same_document` (pushState traversal — popstate
      # already fired, no load), `:cross_document` (full document replay —
      # load follows), or `nil` (no-op: zero delta / out of range).
      def history_go(delta, force: false)
        delta = delta.to_i
        return if delta == 0
        target = @history_idx + delta
        return if target < 0 || target >= @history.size
        if same_document_traversal?(@history_idx, target)
          # …unless this is the page being navigated away from, running its last
          # due-now step: the navigation already under way wins, and moving the
          # index here would leave it pointing at an entry that isn't the document
          # about to commit (see `flush_outgoing_page_init`).
          #
          # Hard to reach on purpose since the page's own init runs with the load
          # (`flush_page_init`) and every find and action drains what is due as it
          # goes: a traversal has to come due in the instant between the last of
          # those and the navigation. It stays because the flush CAN still fire one
          # — a timer that came due while the test was busy in Ruby — and the cost
          # of being wrong there is a history index that doesn't describe the
          # document.
          return :same_document if @flushing_outgoing_page
          # Pure pushState traversal — no VM rebuild, safe to run
          # inline; the popstate dispatch happens within the current
          # call's JS context.
          @history_idx = target
          entry   = @history[target]
          old_url = @current_url
          @current_url = entry[:url]
          @runtime.call('__csimUpdateLocation', @current_url)
          @runtime.call('__csimDispatchPopState', entry[:state])
          # (…and a `hashchange` queued where the fragment moved — HTML "update document for history step application")
          @runtime.call('__csimQueueHashChange', old_url, @current_url) if fragment_of(old_url) != fragment_of(@current_url)
          :same_document
        elsif force
          # Ruby-driven (`page.go_back`), or a non-active window driven by its
          # opener (`w.history.back()`) — no live JS call on THIS window's
          # isolate to interrupt, safe to rebuild the Context synchronously.
          perform_history_traverse(target)
          :cross_document
        else
          # JS-driven (`history.back()` from a page handler): replaying
          # the history entry synchronously would call `rebuild_ctx`
          # on the still-executing Context and terminate the current
          # call with `ScriptTerminatedError` (terminating the
          # in-flight call on the isolate). Stash the intent
          # and drain after the call returns — mirrors
          # `location_assign` / `location_reload`.
          @pending_history_traverse = target
          :cross_document
        end
      end

      def consume_pending_history_traverse
        return unless (target = @pending_history_traverse)
        @pending_history_traverse = nil
        perform_history_traverse(target)
      end

      private def perform_history_traverse(target)
        # Before the index below moves (see `flush_outgoing_page_init`).
        flush_outgoing_page_init if @timers_active
        capture_outgoing_form_state
        @history_idx = target
        replay_history_entry(@history[target])
        restore_form_state(@history[target])
        restore_flushed_nav_intents
      end

      # Snapshot the OUTGOING document's form-control state into the history entry
      # we are leaving, so a later back/forward traversal to it restores the
      # values the user/script had set (HTML "persisted user state"), not the
      # markup defaults. Captured while the outgoing VM is still live — before
      # record_history advances the index or boot rebuilds the context.
      def capture_outgoing_form_state
        return if @history_idx < 0 || (entry = @history[@history_idx]).nil?
        state = @runtime.call('__csimCaptureFormState')
        entry[:form_state] = state if state
      end

      # Re-apply a history entry's captured form state after its document has been
      # rebuilt. The JS setters set the dirty value flag WITHOUT firing
      # input/change, so a restored value doesn't look like a fresh user edit.
      def restore_form_state(entry)
        return unless entry && (state = entry[:form_state])
        @runtime.call('__csimRestoreFormState', state)
      end

      # Same-document = every entry between `from` and `to` (inclusive)
      # is a `:push_state` entry (or the boundary just changed state on
      # the current URL). A `:visit` entry between them means we'd
      # cross a real navigation, which needs a fresh document.
      # A URL's fragment — nil where it has none, which an empty one is not.
      def fragment_of(url)
        url.to_s.include?('#') ? url.to_s.split('#', 2)[1] : nil
      end

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
      # …and one in place of the current entry (a `location.replace`), the forward tail kept.
      def replace_history(entry)
        return record_history(entry) if @history.empty?
        @history[@history_idx] = entry.merge(kind: entry[:kind] || :visit)
      end
      # `is_reload` distinguishes a RELOAD of the current entry (`refresh`) from a
      # history TRAVERSAL (`go_back`/`go_forward`) — a controlling SW observes the
      # difference on `event.request.isReloadNavigation` / `.isHistoryNavigation`.
      # (…its document made with the entry's classic history API state — `history.state` before its scripts run, as a
      # reload or a traversal to it gives it, HTML "update document for history step application")
      def replay_history_entry(entry, is_reload: false)
        return unless entry
        @restoring_history_state = entry[:state]
        if entry[:method] == :post
          navigate_post(entry[:url], entry[:body], entry[:content_type], from_history: true, is_reload: is_reload, initiator: nil)
        else
          navigate(entry[:url], from_history: true, is_reload: is_reload, initiator: nil)   # user traversal: site 'none'
        end
      ensure
        @restoring_history_state = nil
      end
      def active_element_handle
        tick_real_time
        h = dom_call('__csimActiveElement').to_i
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
        # arrow navigation) commits before the next key fires. Tab is a
        # key as any — its events, a listener's cancel, the chord held
        # (keys.rs `FOCUS_NAVIGATION`) — and backtab Shift + Tab.
        held = []
        Array(keys).each do |k|
          sym = k.is_a?(Symbol) ? k : (k.respond_to?(:to_sym) ? k.to_sym : nil)
          if sym && MODIFIER_KEY_NAMES.include?(sym)
            held << sym
          else
            handle = active_element_handle
            handle = current_document_handle if handle.nil? || handle.zero?
            key = sym == :backtab ? :tab : k
            chord = sym == :backtab ? held | [:shift] : held
            send_keys(handle, [chord.empty? ? key : (chord + [key])])
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
          snapshot = error || @trace_mode == :full
          # The DOM snapshot follows the same one-per-ACTION rule the screenshot does. Capybara
          # records a step per RETRY, and serializing on each is the expensive half of tracing:
          # measured, one click under an overlay that never clears records 183 attempts inside its
          # 2 s wait — and, before this, 183 DOM serializations with it, 110 KB
          # of JSON for ONE click on a trivial page.
          dom      = snapshot && !@trace.retrying_failure?(kind, desc) ? html : nil
          # A screenshot only in `full` mode, and there only for an action that SUCCEEDED. Painting
          # a failure would put the paint inside Capybara's retry window — measured, 33 ms for a
          # SMALL page and 236 ms for a 2000-row table — and an action a retry would have rescued
          # starts failing because we photographed the first attempt: a click waiting on an overlay
          # went from 35 ms to 563 ms. It is also the wrong frame: of a retried action, the
          # interesting one is the attempt that finally worked. What a failure looks like is
          # captured once, after the example, where no wait window is running (`TracePersistence`).
          shot     = @trace_mode == :full && error.nil? ? trace_screenshot : nil
          @trace.finish_step(url_after: @current_url, dom_after: dom, shot_after: shot, error: error)
          @recording_action = false
        end
      end

      # Resolved once — log_console fires for every page console.* line
      # (CLAUDE.md rule 3: no per-call ENV reads on hot paths).
      CONSOLE_STDERR = ENV['CSIM_CONSOLE_STDERR'] == '1'

      def log_console(severity, message)
        # Diagnostic mirror: surface page console output on stderr regardless
        # of trace state (engine bring-up / CI triage).
        warn "[console:#{severity}] #{message.to_s[0, 300]}" if CONSOLE_STDERR
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

      # The source map module `url` names in its `sourceMappingURL` comment, read out of its text `src` as it is
      # compiled — a module with no such comment forgets one it had.
      def note_module_source_map(url, src)
        directive = StackResolver.mapping_url(src)
        directive ? (@module_source_maps ||= {})[url.to_s] = directive : @module_source_maps&.delete(url.to_s)
      end
      # …the one script `url` named as it ran — a module's, or a classic script's, which the bridge keeps (`noteSourceMap`)
      # — or nil.
      def source_map_of(url)
        @module_source_maps&.[](url.to_s) || @runtime.call('__csimSourceMapOf', url.to_s)
      rescue StandardError
        nil
      end

      def log_network(method, url, status, **extra) = @trace&.log_network(method, url, status, **extra)

      # `tag#id.class` short description of the handle, for trace
      # `description` fields. One V8 round-trip; only paid when a step
      # is actively being recorded (`record_action` lazy-evaluates the
      # description Proc).
      def describe_node_handle(handle)
        return "handle=#{handle}" if handle.nil? || handle.zero?
        info = dom_call('__csimDescribeNode', handle)
        return "handle=#{handle}" unless info.is_a?(Hash)
        s = info['tag'].to_s
        s += "##{info['id']}"  unless info['id'].to_s.empty?
        s += ".#{info['cls']}" unless info['cls'].to_s.empty?
        s
      end
      def evaluate_script(code, args = [])
        # The page a script is about to read must have had its `load` — see
        # `flush_pending_window_load`; the tick below is gated and may not run at all.
        flush_pending_window_load
        # Drain timers first so ready handlers (jQuery `$(handler)`,
        # framework `DOMContentLoaded` listeners) run before the
        # user's script. Without this, `execute_script` can fire
        # *before* the page's own setup code that the test expects
        # to be active.
        tick_real_time
        flush_module_rt
        invalidate_find_cache
        # Routes to the active frame realm inside `within_frame` (Selenium
        # parity: `evaluate_script` runs in the current browsing context).
        result = dom_call('__csimEvalScript', code.to_s, marshal_args(args || []))
        settle_idle_style
        drain_task_intents
        result
      end

      # Fire-and-forget variant: runs the script but never returns
      # its value to Ruby. Lets execute_script handle scripts whose
      # return is a complex JS object (jQuery chainable, DOM tree,
      # …) that the marshaller would recurse into.
      def execute_script(code, args = [])
        tick_real_time
        flush_module_rt
        invalidate_find_cache
        dom_call('__csimExecScript', code.to_s, marshal_args(args || []))
        settle_idle_style
        drain_task_intents
        nil
      end

      # A task this driver ran has ended: under the style engine, the style it changed is applied on an idle page, as a
      # browser's rendering update would apply it — which starts any transition or animation it declares, and those keep
      # the page stepping (timers.js `__csimSettleIdleStyle`).
      def settle_idle_style
        @runtime.call('__csimSettleIdleStyle')
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
      # the marshaller can't pass a Ruby Node, so wrap as a sentinel
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
        # Runs in the active frame realm inside `within_frame` (Selenium
        # parity), same as evaluate_script; the result slot is realm-local so
        # the poll below must read from the same realm.
        dom_call('__evalAsyncScript', code.to_s, marshal_args(args || []))
        settle_idle_style
        # Pump virtual time so any setTimeout-driven completion lands.
        # Capybara's polling can't help here — we're inside one session
        # call, not a retry loop.
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) +
                   Capybara.default_max_wait_time.to_f
        loop do
          result = dom_call('__pollAsyncResult')
          return result['value'] if result.is_a?(Hash) && result.key?('value')
          break if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
          sleep 0.01
          tick_real_time
        end
        raise ScriptTimeoutError, "the script did not call its callback within #{Capybara.default_max_wait_time} seconds"
      ensure
        # (…and what the script left to do, once its result is read: a navigation would take the result with the page)
        drain_task_intents
      end

      def current_path
        tick_real_time
        return '' if @current_url.nil? || @current_url.empty?
        parse_url(@current_url)&.fetch(:pathname) || ''
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
        return true if worker_pending? || event_source_pending? || hijack_fetch_pending? || window_message_pending? || websocket_pending?
        # …and a worker whose own timers are still to fire counts as the page's own do: it runs on its own thread and
        # clock, and what it posts when they fire is what a wait is for — `setTimeout(() => postMessage('w2'), 300)`
        # arrived after the wait had given up, because nothing on THIS page was pending. Under the same idle gate, so a
        # worker's forever `setInterval` (a heartbeat) cannot make every negative matcher wait out its whole timeout.
        if @timers_active || worker_timers_pending?
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
      # When `step_ms` is omitted, advance by `horizon_fast_forward_step` — a
      # DETERMINISTIC step (never wall-derived, so per-poll JS/Ruby/GC cost can't
      # shift when a timer fires): a fixed `POLL_TICK_STEP_MS` per poll, fast-
      # forwarding straight to a near-future timer when the page is otherwise idle.
      # Explicit `step_ms` is used by `SleepHook#advance_virtual_clock_ms` (from
      # `Kernel#sleep`) and by `Playwright::Page#wait_for_timeout` to step a
      # precise virtual duration.
      def tick_real_time(step_ms: nil)
        return unless @timers_active || async_io_pending?
        # Re-entrancy guard. Capybara's `Result#each` triggers nested
        # finds (visible? per element); the outermost tick has already
        # advanced the clock, the inner calls would only re-drain
        # already-fired timers.
        return if @ticking
        # Any advance discharges what a read owed (`tick_for_read`) — including one an
        # action or a find made for its own reasons.
        @read_owes_tick = false
        @ticking = true
        begin
          now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          # Kept wall-anchored ONLY for `timer_wait_elapsed?` / FIND_PRE_TICK_MIN_S
          # (gates tick FREQUENCY for the smoke first-find-no-fire contract); the
          # step SIZE below is deterministic.
          @last_tick_ts = now
          effective_step = step_ms || horizon_fast_forward_step
          if @timers_active && effective_step > 0
            # When the page has work runnable NOW (a rAF chain / timer burst — set
            # by `horizon_fast_forward_step`), run the poll's worth of virtual time
            # in frame-sized chunks so the page renders at real-browser cadence
            # rather than one `POLL_TICK_STEP_MS` super-frame. The `step_ms` path
            # (explicit `sleep` / `wait_for_timeout`) and idle/parked/fast-forward
            # polls keep the single step — nothing is rendering frame-by-frame, so
            # sub-stepping would only spin empty render phases. The tail-jump bails
            # the moment a frame goes quiet, so a chain that settles early (or the
            # rare quiet sub-step) doesn't pay for the unused remainder.
            if step_ms.nil? && @page_runnable_now && effective_step > FRAME_STEP_MS
              remaining = effective_step
              # Share ONE task-iteration budget across the chunks so the per-poll
              # cap matches the single-step path (each `run_loop_step` otherwise
              # gets a fresh `RUN_LOOP_MAX_ITER`, so an always-due `setInterval(0)`
              # busy loop could run N× the work). Exhausting it ends the poll —
              # the clock is stuck on that loop either way.
              iter_budget = RUN_LOOP_MAX_ITER
              while remaining > 0 && iter_budget > 0
                chunk = remaining < FRAME_STEP_MS ? remaining : FRAME_STEP_MS
                r = @runtime.run_loop_step(chunk, iter_budget)
                @find_cache_dirty = true if r['dirtied'] || r['fired'].to_i > 0
                remaining    -= chunk
                iter_budget  -= r['fired'].to_i
                # Idle frame → nothing left to render frame-by-frame this poll: jump
                # the remaining advance in one step (fires any timer parked within
                # it). A still-queued rAF (`r['raf']`) is NOT idle — a non-mutating
                # animation chain fires no timer and dirties nothing yet keeps
                # rendering, so keep sub-stepping it at frame cadence.
                if remaining > 0 && r['fired'].to_i.zero? && !r['dirtied'] && !r['raf']
                  r = @runtime.run_loop_step(remaining, iter_budget)
                  @find_cache_dirty = true if r['dirtied'] || r['fired'].to_i > 0
                  break
                end
              end
            else
              r = @runtime.run_loop_step(effective_step)
              # `dirtied` (settleGen changed) catches a render-phase rAF / microtask-
              # delivered MutationObserver that mutated the DOM without firing a timer
              # (fired == 0) — a fired-count-only test would leave a stale find cache.
              @find_cache_dirty = true if r['dirtied'] || r['fired'].to_i > 0
            end
          end
          # Pull any pending Worker / EventSource messages into JS
          # state. Without this, `evaluate_script` after kicking off
          # a worker round-trip would see stale state — the inbox
          # outbox only drains during `settle`, which doesn't run
          # for direct `execute_script` / `evaluate_script` calls.
          drain_async_channels
        ensure
          @ticking = false
        end
        # What the handlers that fired during the drain left to do (e.g. `setTimeout(() => location.pathname = X)`).
        # Outside the @ticking guard so the navigate's rebuild_ctx is well-clear of the V8 call we just made.
        drain_task_intents
      end

      # What a task the page ran left the browser to do, done: a navigation it planned (`drain_pending_navigation`), a
      # hyperlink it followed, a form it submitted, a download it started — of the first three the one planned last,
      # each superseding the others as it is planned (location.js `supersedePlannedNavigation`). Whichever task — a timer's (Forem's comment-edit form `preventDefault`s
      # its submit, polls for the CSRF meta tag inside `setInterval(…, 1)` and calls `form.submit()` once it is there,
      # long after the click returned), a script the driver ran (`execute_script('form.submit()')` on an idle page, where
      # no step follows to take it), or a synthetic click on an `<a download>` (Avo's action download: file-saver's
      # `saveAs` dispatches one on a fresh anchor with a blob URL). Otherwise what it planned is never taken.
      def drain_task_intents
        drain_pending_navigation
        consume_pending_navigation
        consume_pending_form_submit
        consume_pending_download
      end

      # Backstop on the per-frame quiescence loop — caps the event-loop turns
      # processed at a single instant so a `setInterval(0)` (always-due) busy loop
      # advances a frame and continues, rather than spinning forever. Generous:
      # real frames here run hundreds of microtask/rAF turns (e.g. ~80 sequential
      # rAF promise_tests, each ~2 render turns).
      EVENT_LOOP_QUIESCENCE_CAP = 512

      # Run ONE real-cadence event-loop frame and report the loop's observable
      # state. A general primitive — it models a browser animation frame and knows
      # nothing about any particular test harness; the WPT runner is its first
      # caller (driving a page to completion one frame at a time). It advances the
      # same virtual clock as the Capybara poll path: `tick_real_time` keeps its own
      # per-poll BUDGET (a ~100 ms `horizon_fast_forward` step, tuned for app
      # debounce observation) but, when the page has work runnable now, spends that
      # budget in `FRAME_STEP_MS` chunks — the same frame cadence this primitive
      # uses — so a page renders frame-by-frame regardless of which path drives it.
      #
      # A real browser processes EVERYTHING ready at the current instant within a
      # single animation frame — microtasks, timers due now (incl. newly scheduled
      # `setTimeout(0)`), the render-phase rAF callbacks, and the navigation /
      # form-submit / worker chains they trigger — and only THEN advances ~16.67 ms
      # to the next frame. Modelling that is essential: a multi-hop chain (a form →
      # iframe-rebuild → onload → next-submit sequence, or N sequential rAF
      # `promise_test`s) must complete inside a frame. Advancing the clock per host
      # round-trip instead (the old WPT runner did ~3 `evaluate_script`s/frame, each
      # a full ~100 ms `tick_real_time` poll tick) runs it ~20× real cadence, so a
      # page that needs many frames trips a wall-clock-budget harness timeout long
      # before its queue drains. Driving the loop here keeps real cadence (one frame
      # interval per frame) while still completing the chains.
      #
      # Phase 1 — quiescence at the CURRENT virtual time: repeatedly run the loop
      # with a ZERO advance (`run_loop_step(0)` fires only timers due now + the
      # microtask checkpoints + the render phase) and drain the Ruby-side async /
      # nav / form-submit / download chains they queue, until a turn makes no
      # observable progress (or the backstop caps a busy loop). Phase 2 — advance
      # exactly one frame so the next batch of timers comes due.
      #
      # Returns the loop state: `progressed` (this frame did real work — drives a
      # caller's idle detection), `raf` (an animation frame is queued), `async` (a
      # non-timer background channel — worker / SSE / hijacked fetch — is in
      # flight), and `next_timer` (ms to the nearest scheduled timer, -1 = none, so
      # a caller can tell a page PARKED on a near-future `setTimeout` from an idle
      # one). Whether the page reached some application-level "done" state is the
      # caller's concern — read it separately with `peek_script` (clock-free).
      def run_event_loop_frame(frame_ms)
        turns = 0
        # Give any live worker/SW thread a clean GVL slice before the phase-1 quiescence loop
        # monopolises it. That loop spins `run_loop_step(0)` holding the GVL, which STARVES a
        # worker mid-flight — in particular a CROSS-ISOLATE zero-copy transfer (`RustyRacer.
        # transferIn` over a SendBackingStore) that a `worker.postMessage(view, [view.buffer])`
        # reply must complete on the worker thread. Under starvation transferIn fails, the SW's
        # message handler throws on the null result, and no reply is posted → the client's
        # `onmessage` never fires and the drain force-timeouts it (postmessage.https transferable
        # subtests; the whole SW→client message reply cluster). A brief `sleep` releases the GVL
        # so the worker runs (Thread.pass does NOT hand it over); gated on a live worker so
        # worker-free files pay nothing.
        sleep(WORKER_GVL_YIELD) if @workers.any? {|_, w| w[:thread]&.alive? }
        # (…and at most a step's worth of tasks at that instant, however many turns they take: a chain of tasks each due
        # at once — an IndexedDB request whose `success` makes the next — is a turn's whole budget every turn)
        tasks = RUN_LOOP_MAX_ITER
        loop do
          r = @runtime.run_loop_step(0, tasks)   # run only what's due NOW + microtasks + render; no clock advance
          progressed = step_and_drain_progressed(r)
          turns += 1
          tasks -= r['fired'].to_i
          break unless progressed
          break if turns >= EVENT_LOOP_QUIESCENCE_CAP || tasks <= 0
        end

        # Interlude — hold the virtual clock while a controlled-client fetch is awaiting the
        # service worker's `respondWith`. The SW does the real request off-thread (a live network
        # hop, an in-VM handler) and its reply is delivered Ruby-side, invisible to the JS event-loop
        # probe. Advancing the clock now (phase 2) would let a caller's virtual-timeout outrun that
        # off-thread work and mark the still-pending fetch as timed-out before the reply lands. So
        # block briefly on the worker outbox — releasing the GVL so the worker runs, exactly like
        # `settle` — and deliver the reply at the current instant, WITHOUT advancing the clock, then
        # keep pumping. A fetch that never replies is bounded by `@sw_fetch_wait_deadline` (and, past
        # that, the caller's own max-steps backstop), so it can't wedge the drain.
        if @sw_fetch_pending.positive? && (held = hold_for_sw_fetch(turns))
          return held
        end
        @sw_fetch_wait_deadline = nil unless @sw_fetch_pending.positive?

        # Same interlude for an in-flight `ws.close()` handshake: the reader thread surfaces the
        # server's echoed close frame as `__close` — real off-thread work the JS event-loop probe
        # can't see. Advancing the clock now would let a test's virtual-timeout ("onclose should
        # fire") outrun it. Block briefly on the WS queue (GVL released, like settle) so the reader
        # runs, deliver at the current instant WITHOUT advancing time, then keep pumping. Bounded by
        # a deadline so a peer that never replies (→ EOF 1006) can't wedge the drain.
        if @ws_close_pending.positive? && (held = hold_for_ws_close(turns))
          return held
        end
        @ws_close_wait_deadline = nil unless @ws_close_pending.positive?

        # Same interlude for a pending SW message swack / broadcast ack — but WITHOUT holding
        # the clock. Its reply is the same kind of cross-isolate transfer completed on the worker
        # thread (a `worker.postMessage(view, [view.buffer])` reply zero-copies via transferIn),
        # so we block briefly on the outbox to give a loaded runner's worker real GVL time to post
        # it, then fall through to phase 2 — a message reply is delivered at the current instant by
        # the drain below and the lifecycle-step / nav tasks its test then waits on advance
        # via the clock, so (unlike a fetch) we must NOT hold: holding regressed about-blank-
        # replacement. See drain_pending_message_reply.
        drain_pending_message_reply if worker_message_reply_pending?
        @sw_msg_wait_deadline = nil unless worker_message_reply_pending?

        # Phase 2 — advance one real frame so the next batch of timers becomes due.
        # Its work counts toward `progressed` too: a timer that first comes due in
        # this advance (e.g. a `setTimeout(…, 8)` firing mid-frame) and the nav hop
        # it queues are real progress, so a caller mustn't read the frame as idle.
        frame_progressed = step_and_drain_progressed(@runtime.run_loop_step(frame_ms))
        probe = dom_call('__csimEventLoopProbe')
        {
          'raf'        => !!probe['raf'],
          # A live WS reader counts as async so the drain loop yields the GVL to it each frame — see
          # websocket_reader_active?. Without it a binary echo can be starved past the idle-bail.
          # Ruby-side worker work counts too (worker_drive_pending?) — the JS probe can't see it.
          'async'      => !!probe['async'] || websocket_reader_active? || worker_drive_pending?,
          # ms until the nearest scheduled timer (-1 = none). Lets a caller keep
          # advancing while a near-future `setTimeout` is parked (a `step_timeout`-
          # style wait) instead of declaring the page idle — see `__csimEventLoopProbe`.
          'next_timer' => [probe['nextTimer'].to_f, worker_next_timer].select {|t| t >= 0 }.min || -1.0,
          # `turns > 1` ⇒ phase 1's quiescence did work (the trailing no-progress
          # turn that ends the loop is the +1); OR phase 2's advance did.
          'progressed' => turns > 1 || frame_progressed
        }
      end

      # Hold the virtual clock for one frame while a controlled-client fetch awaits the SW's
      # respondWith. Blocks briefly on the worker outbox (GVL released) up to a budget shared across
      # frames; on a reply, delivers it at the current instant (a zero-advance `run_loop_step`) and
      # returns the frame's loop-state so the caller keeps pumping without advancing time. Returns
      # nil once the budget is spent, so the caller falls through to a normal frame (advancing the
      # clock) and a genuinely stuck fetch can't wedge the drain. Reports the REAL nearest timer —
      # holding the clock doesn't hide a parked timer, we simply haven't advanced to it yet.
      private def hold_for_sw_fetch(turns)
        @sw_fetch_wait_deadline ||= Process.clock_gettime(Process::CLOCK_MONOTONIC) + WORKER_ROUND_TRIP_BUDGET
        park_worker_reply(@sw_fetch_wait_deadline)
        reply_ready = @worker_outbox_head || !@worker_outbox.empty?
        # A delivered reply refreshes the budget so the NEXT fetch in a sequence waits afresh instead
        # of inheriting a spent deadline (which would abandon it to a premature timeout).
        @sw_fetch_wait_deadline = nil if reply_ready
        return nil unless reply_ready || Process.clock_gettime(Process::CLOCK_MONOTONIC) < @sw_fetch_wait_deadline

        held_progressed = reply_ready && step_and_drain_progressed(@runtime.run_loop_step(0))
        probe = dom_call('__csimEventLoopProbe')
        {
          'raf'        => !!probe['raf'],
          'async'      => true,
          'next_timer' => probe['nextTimer'].to_f,
          'progressed' => turns > 1 || held_progressed
        }
      end

      # Hold the virtual clock while a `ws.close()` handshake completes. Mirrors hold_for_sw_fetch,
      # but the reply arrives on the WS queue (the reader thread), not the worker outbox: park
      # briefly on that queue (GVL released, so the reader runs) and, once a frame is ready, deliver
      # it at the current instant (`run_loop_step(0)` → deliver_websocket_events clears the counter)
      # WITHOUT advancing time. Returns the frame-probe hash to hold; nil only once the deadline is
      # spent with nothing delivered, so the caller falls through to phase 2 and the clock resumes.
      private def hold_for_ws_close(turns)
        @ws_close_wait_deadline ||= Process.clock_gettime(Process::CLOCK_MONOTONIC) + WORKER_ROUND_TRIP_BUDGET
        if @websocket_queue_head.nil? && @websocket_queue.empty? && Process.clock_gettime(Process::CLOCK_MONOTONIC) < @ws_close_wait_deadline
          # Pop one event to block until the reader produces something, then park it in the one-slot
          # HEAD buffer — NOT pushed back onto the tail, which would reorder it behind anything the
          # reader enqueued in the meantime. deliver_websocket_events drains the head first. Mirrors
          # park_worker_reply.
          @websocket_queue_head = pop_with_timeout(@websocket_queue, WORKER_POLL_INTERVAL)
        end
        ready = !@websocket_queue_head.nil? || !@websocket_queue.empty?
        # A delivered frame refreshes the budget so the NEXT close in a sequence waits afresh.
        @ws_close_wait_deadline = nil if ready
        return nil unless ready || Process.clock_gettime(Process::CLOCK_MONOTONIC) < @ws_close_wait_deadline

        held_progressed = ready && step_and_drain_progressed(@runtime.run_loop_step(0))
        probe = dom_call('__csimEventLoopProbe')
        {
          'raf'        => !!probe['raf'],
          'async'      => true,
          'next_timer' => probe['nextTimer'].to_f,
          'progressed' => turns > 1 || held_progressed
        }
      end

      # Park briefly (GVL released) for an outstanding SW message swack / broadcast ack and deliver
      # it at the current instant, then RETURN — the caller proceeds to phase 2 and advances the
      # clock. Unlike `hold_for_sw_fetch` this does NOT hold time: a message/broadcast reply's test
      # advances its lifecycle-step / nav tasks via the clock, so holding on it deadlocks
      # (regressed about-blank-replacement). The only thing missing under load is worker GVL time for
      # the cross-isolate transferable reply to complete — a fixed micro-sleep isn't enough margin on
      # a loaded runner (postmessage.https transferable subtests), so we block on the outbox exactly
      # like the fetch hold / `settle`. Budget shared across frames (a genuinely stuck reply pays it
      # once — the spent deadline stays in the past, so later frames don't re-block and the clock runs
      # free until the reply lands or the test times out); reset in `run_event_loop_frame` once no
      # message/broadcast reply is outstanding, so the next one waits afresh.
      private def drain_pending_message_reply
        @sw_msg_wait_deadline ||= Process.clock_gettime(Process::CLOCK_MONOTONIC) + WORKER_ROUND_TRIP_BUDGET
        park_worker_reply(@sw_msg_wait_deadline) while worker_message_reply_pending? &&
          @worker_outbox.empty? && @worker_outbox_head.nil? &&
          Process.clock_gettime(Process::CLOCK_MONOTONIC) < @sw_msg_wait_deadline
        # `deliver_worker_messages` (inside step_and_drain) refreshes @sw_msg_wait_deadline whenever it
        # delivers a swack/bcack, so the NEXT reply in a sequence waits afresh — and it does so on
        # WHICHEVER drain path delivered the reply (this one, hold_for_sw_fetch's outbox drain, or
        # settle), which resetting only here would miss when a co-pending fetch hold delivers it.
        step_and_drain_progressed(@runtime.run_loop_step(0)) if @worker_outbox_head || !@worker_outbox.empty?
      end

      # Block up to one poll interval for a worker reply, parking it in the one-slot head buffer —
      # NOT pushed back, which would reorder it behind anything the worker enqueued meanwhile. The
      # `pop_with_timeout` releases the GVL so the worker thread runs and wakes us the instant it
      # posts. No-op if a reply is already buffered or the budget is spent. Shared by `settle` and
      # the SW-fetch hold in `run_event_loop_frame`.
      private def park_worker_reply(deadline)
        return unless @worker_outbox.empty? && @worker_outbox_head.nil? &&
                      Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
        @worker_outbox_head = pop_with_timeout(@worker_outbox, WORKER_POLL_INTERVAL)
      end

      # Drain the Ruby-side async / navigation / form-submit / download chains a
      # `run_loop_step` (passed as `r`) may have queued, and report whether this
      # step+drain made observable progress. Shared by both phases of
      # `run_event_loop_frame`.
      #
      # A pending Ruby-side navigation/submit/reload intent counts as progress:
      # draining it rebuilds a child frame realm and fires that iframe's `onload`
      # synchronously, whose handler can queue the NEXT hop (submit-entity-body's
      # `run_simple_test` chain: form.submit() → realm rebuild → onload → next
      # form.submit()). That work happens entirely in the CHILD realm, so it bumps
      # the child's `settleGen`, never the main realm's `settle_gen` we sample, and
      # fires no main-realm timer. Snapshot the intent BEFORE draining: this call
      # consumes one hop and the onload re-queues the next, which the following
      # call sees — so the quiescence loop self-terminates when the chain ends.
      private def step_and_drain_progressed(r)
        pulled = drain_async_channels
        invalidate_find_cache
        drained_nav = pending_nav_intent?
        drain_task_intents
        # `r['dirtied']` already covers settleGen changes DURING the step; compare
        # the post-drain gen against the step's post-step gen (`r['gen']`, free —
        # no extra crossing) to also catch a main-realm change the drains caused.
        r['fired'].to_i.positive? || r['dirtied'] || pulled || drained_nav ||
          @runtime.settle_gen != r['gen'].to_i
      end

      # Clock-FREE read of a JS expression in the active browsing context. Unlike
      # `evaluate_script` (which ticks `tick_real_time` first), this is a bare
      # `dom_call` and advances no virtual time — so a caller polling page state
      # once per `run_event_loop_frame` (e.g. the WPT runner checking its harness's
      # completion sentinel) doesn't perturb the frame cadence the loop maintains.
      def peek_script(expr)
        dom_call('__csimEvalScript', expr.to_s, marshal_args([]))
      end

      # Any Ruby-side navigation intent queued and waiting for `drain_pending_navigation`
      # to act on it — the same set that method drains (location / frame nav / frame
      # submit / frame reload / reload / history traverse). The quiescence loop treats
      # a queued intent as progress because draining it does cross-realm work (rebuild
      # a child frame realm + fire its `onload`) that the main-realm `settleGen` /
      # fired-timer signals can't see. Aux-window opens are intentionally excluded:
      # they build a separate Browser, not a hop in a same-page chain.
      private def pending_nav_intent?
        !@pending_location.nil? ||
          @pending_reload ||
          !@pending_history_traverse.nil? ||
          !(@pending_frame_nav || {}).empty? ||
          !(@pending_frame_submit || []).empty? ||
          !@pending_page_submission.nil? ||
          !(@pending_frame_reload || []).empty?
      end

      # Pull every background async channel (Worker / EventSource / hijacked fetch
      # / postMessage / WebSocket) into JS state, marking the find cache dirty if
      # any delivered. Shared by `tick_real_time` and `run_event_loop_frame`.
      # Returns true if any channel delivered.
      private def drain_async_channels
        n = deliver_worker_messages + deliver_event_source_events + deliver_hijacked_fetches +
            deliver_window_messages + deliver_websocket_events + deliver_image_loads + deliver_agent_notices
        @find_cache_dirty = true if n.positive?
        n.positive?
      end

      # This tick's deterministic virtual-clock advance (ms). Default is the fixed
      # `POLL_TICK_STEP_MS` — never wall-derived, so per-poll JS/Ruby/GC cost cannot
      # shift WHEN a timer fires (the wall-sync↔perf coupling this replaces). When
      # the page is observably idle (nothing runnable now, no background IO) but a
      # near-future timer is parked within `FF_HORIZON_MS`, fast-forward straight to
      # it — but only after the transient-guard window so pre-debounce states are
      # still observed across several polls. `FF_HORIZON_MS=0` ⇒ pure fixed-step.
      def horizon_fast_forward_step
        # Whether the page has work runnable at the CURRENT instant (a rAF or a
        # due-now timer). Only then does `tick_real_time` sub-step the advance into
        # frames — an idle/parked poll has nothing to render frame-by-frame, so it
        # stays a single step (no extra render phases on the common idle-wait poll).
        @page_runnable_now = false
        # Escape hatch to the legacy wall-sync clock (virtual advance = real
        # wall-elapsed per poll). The deterministic model decouples perf from
        # timing but can't match a real browser's wall-proportional cadence for
        # timing-fragile heavy-JS flows; `CSIM_CLOCK_WALL=1` restores wall-sync.
        if @clock_wall
          now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          step = ((now - (@wall_clock_last || now)) * 1000).to_i.clamp(0, 1000)
          @wall_clock_last = now
          return step
        end
        # (1) Background async (cheap Ruby-side checks, no V8 crossing) we must let
        #     land before jumping the clock: advance one fixed step, reset the guard.
        if worker_pending? || event_source_pending? || hijack_fetch_pending? || websocket_pending? || image_loads_pending? || agent_notices_pending?
          @ff_transient_polls = 0
          return POLL_TICK_STEP_MS
        end
        # ONE V8 crossing: `delay` = ms until the nearest timer; 0 = runnable now
        # (a rAF or a due-now timer — equivalent to `has_ready_timer?`), -1 = none.
        delay = @runtime.next_timer_delay_ms
        # (2) Runnable now → fixed step, reset guard (not a quiet pre-debounce window).
        if delay.zero?
          @ff_transient_polls = 0
          @page_runnable_now  = true
          return POLL_TICK_STEP_MS
        end
        # (3) Nothing parked → nothing to fast-forward to.
        return POLL_TICK_STEP_MS if delay.negative?
        # (4) Beyond the horizon (ahoy 1000 / session-timeout / analytics): leave
        #     parked, advance only at the fixed rate. Not a transient window.
        if delay > FF_HORIZON_MS
          @ff_transient_polls = 0
          return POLL_TICK_STEP_MS
        end
        # (5) Near-future timer, page idle: hold the pre-debounce window for the
        #     guard so transient-catch tests observe the intermediate state.
        @ff_transient_polls = (@ff_transient_polls || 0) + 1
        return POLL_TICK_STEP_MS if @ff_transient_polls < FF_TRANSIENT_GUARD_POLLS
        # (6) Fast-forward: jump exactly to the next timer's due. `runLoopStepLocal`
        #     breaks on strict `nextDue > limit`, so `limit = virtualNow + delay`
        #     (== that timer's due) fires it — and ONLY it, not a timer 1 ms later.
        delay
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
        @last_tick_ts       = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @wall_clock_last    = @last_tick_ts   # CSIM_CLOCK_WALL escape hatch: don't replay the prev page's gap
        @timers_active      = false
        @polling_grace      = nil
        @last_polled_gen    = nil
        @idle_settle_polls  = 0
        @ff_transient_polls = 0
        # Disarm the find pre-tick so the FIRST find after this navigation reads the current DOM
        # without advancing timers (see timer_wait_elapsed?), independent of wall-clock timing.
        @pre_tick_armed     = false
        # No read of the previous document owes anything — see `tick_for_read`.
        @read_owes_tick   = false
        @last_read_handle = nil
        @context_gen       += 1
      end

      attr_reader :context_gen

      # A form's submission, its request as it was submitted (`__csimFormSerialize`): the navigation it makes — `navigate`
      # for a GET, a POST else — the current document's, for what its response would download (`from_document`).
      def submit_form_spec(spec)
        from_document(@current_realm_id.to_i) { submit_form_spec_in_document(spec) }
      end
      # A navigation the document of realm `realm` makes, run with it its source (`@download_source`): what a download its
      # response is may be saved by (`save_downloaded_response`).
      def from_document(realm)
        saved, @download_source = @download_source, realm
        yield
      ensure
        @download_source = saved
      end
      def submit_form_spec_in_document(spec)
        invalidate_find_cache
        return unless spec.is_a?(Hash)
        # (…an entered frame's `_top` / `_parent` routed as a submission its document planned is: the navigable it chooses,
        # its sandbox, its Referer and `noreferrer` — the frame's)
        if @current_realm_id && [TARGET_TOP, TARGET_PARENT].include?(target_keyword(spec['target'].to_s))
          return submit_form_in_realm(@current_realm_id.to_i, spec)
        end
        # (…its action resolved as it was submitted: the document's URL where it has none)
        action_url = resolve_against_current(spec['action'].to_s)
        action_url = parse_url(action_url.to_s)&.fetch(:href) || action_url.to_s
        request = form_request(spec, action_url)
        return unless request

        method, url, body, content_type = request
        # A form submitted inside a frame whose target is that frame (self, or a
        # `_parent` of a ≥2-deep frame) navigates the FRAME, not the top page.
        frame_entry = frame_nav_target_entry(spec['target'])
        target  = spec['target'].to_s
        keyword = target_keyword(target)
        named   = frame_entry.nil? && keyword == TARGET_NAME
        # A name chooses the navigable it is the target name of (`choose_named_navigable`): a frame's anywhere in the page
        # — navigated as the frame's own navigation is, this browsing context its initiator — or this window's (navigated
        # in place), or one a sandbox keeps this document from navigating (nothing is); a name no navigable has, and
        # `_blank`, submit into a NEW browsing context — an aux window opened (or reused), mirroring the link
        # `target=_blank` branch.
        chosen = named ? choose_named_navigable(@current_realm_id.to_i, target) : nil
        return if chosen == :blocked
        named_frame = chosen if chosen.is_a?(Integer)
        new_window  = frame_entry.nil? && chosen.nil? && new_window_target?(target)
        window_name = keyword == TARGET_BLANK ? '' : target
        # Opener exposure for a `<form target>` new context: HTML "get an element's noopener", the engine's
        # (token_list.rs `noopener`) — `noopener` / `noreferrer` drop it, `_blank` without `opener` too, a named target
        # keeps it. `noreferrer` also empties the referrer.
        no_referrer = Native.link_noreferrer(spec['rel'].to_s)
        keep_opener = !Native.link_noopener(spec['rel'].to_s, target)
        # (…replacing the session history entry of the form's document where that is not completely loaded yet: the
        # page's, whose own navigable it navigates — `request.replace`)
        replace = spec['replace'] == true
        # (…and whatever it navigates — a new window too — is told its initiator, the form's document under its policy or
        # the one `noreferrer` sets: HTML "plan to navigate" sets the referrer policy "no-referrer" where the form's link
        # types include it)
        initiator = realm_referrer_initiator(@current_realm_id.to_i)
        initiator = [initiator[0], 'no-referrer'] if no_referrer
        policy    = no_referrer ? 'no-referrer' : nil
        # (…a new window's under that document's policy, the default where it sets none: not the page's)
        window_policy = initiator[1].to_s.empty? ? DEFAULT_REFERRER_POLICY : initiator[1]
        if @current_realm_id && !new_window && !named_frame && !frame_entry
          # (…an entered frame's form whose target names the page navigates it as the frame's `_top` does: its Referer and
          # site the frame document's)
          post = method == 'GET' ? nil : [body, content_type]
          in_top_context { navigate_top_from(@current_realm_id.to_i, initiator, url, post: post) }
        elsif method == 'GET'
          if new_window
            @driver.open_aux_window(url, name: window_name, source: self, activation_realm: @current_realm_id.to_i,
                                    opener: keep_opener, referrer: initiator[0].to_s, referrer_policy: window_policy)
          elsif named_frame
            navigate_realm_self_get(named_frame, url, referrer: initiator)
          elsif frame_entry
            navigate_frame(url, entry: frame_entry, referrer: initiator)
          else
            navigate(url, referrer_policy: policy, replace: replace)
          end
        else
          if new_window
            @driver.open_aux_window(url, name: window_name, source: self, activation_realm: @current_realm_id.to_i,
                                    opener: keep_opener, referrer: initiator[0].to_s, referrer_policy: window_policy,
                                    post: {body: body, content_type: content_type})
          elsif named_frame
            navigate_realm_self_post(named_frame, url, body, content_type, referrer: initiator)
          elsif frame_entry
            navigate_frame_post(url, body, content_type, entry: frame_entry, referrer: initiator)
          else
            navigate_post(url, body, content_type, referrer_policy: policy, replace: replace)
          end
        end
      end

      # A form's submission as its request — [method, url, body, content_type], the body and its type nil for a GET — or
      # nil where it submits nothing (its action no URL), the engine's (text_codec.rs `form_request`): `spec` the form's
      # (`__csimFormSerialize`), its action resolved as `action_url`. Each entry string {'name','value'} or file
      # {'name','file'=>true,'filename','type', and 'handle'/'index' or 'bytes'}: a file's bytes read — only where its
      # body carries them — through its `@file_picks` slot, else the VM's (an in-memory `new File([…])`).
      def form_request(spec, action_url)
        list = (spec['entries'] || []).map {|e|
          next [e['name'].to_s, e['value'].to_s] unless e['file']

          [e['name'].to_s, e['filename'].to_s, e['type'].to_s, entry_file_path(e), e['bytes']&.to_s&.b]
        }
        Native.form_request(action_url.to_s, spec['method'].to_s, spec['enctype'].to_s, spec['encoding'] || 'UTF-8', list)
      end

      # A threaded file entry's on-disk path, through the `@file_picks` slot recorded at `attach_file` time
      # (handle/index) — nil for an in-memory `new File([…])`, which has no slot (its bytes come from the VM).
      def entry_file_path(entry)
        handle = entry['handle']
        return nil if handle.nil?
        picks = @file_picks && @file_picks[handle.to_i]
        picks && picks[entry['index'].to_i]
      end

      def navigate_post(url, body, content_type, depth: 0, from_history: false, is_reload: false, referer: @current_url, referrer_policy: nil, initiator: @current_url, site_seed: nil, replace: false, origin_null: false)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
        # Before ANY of this navigation lands (see `flush_outgoing_page_init`).
        # `from_history` already flushed at its own entry point, which commits the
        # history index before it gets here.
        flush_outgoing_page_init if depth.zero? && !from_history && @timers_active
        # (…its Referer the initiating document's URL — `referer` — under that document's referrer policy, the policy its
        # `<meta name="referrer">` sets (the default where none does) read before the page goes, determined anew at each
        # redirect hop as Fetch's main fetch does; a driver's visit sends none on any hop)
        referrer_policy ||= main_document_referrer_policy if referer && depth.zero?
        hop_referer = referer && compute_referrer(referrer_policy.to_s, referer, url)
        @history_before_navigation = nil if depth.zero?
        unless from_history || depth > 0
          capture_outgoing_form_state
          record_navigation_history({method: :post, url: url, body: body, content_type: content_type}, replace: replace)
        end
        # A controlled top-level POST navigation (form submission) goes to the SW's fetch
        # event first — same model as `navigate` (the SW reads the body via
        # `event.request.text()`); respondWith serves the document, nil falls through to
        # the network POST below. The wire Content-Type carries the same urlencoded
        # default the network path applies, so `event.request.headers` matches Chrome.
        nav_site = widen_sec_fetch_site(site_seed, sec_fetch_site(initiator, url))
        if (sw = any_window_sw_navigation_fetch(url, method: 'POST', body: body,
                                                     content_type: content_type.to_s.empty? ? 'application/x-www-form-urlencoded' : content_type,
                                                     is_reload: is_reload, is_history: from_history && !is_reload,
                                                     dest: 'document', referrer_source: initiator, site_seed: site_seed))
          # Same post-response pipeline as the network POST below: a network error commits
          # an error document at the target URL; 307/308 re-POST, other redirects GET;
          # an attachment downloads.
          return commit_error_document(url) if sw['networkError']
          sw_headers = sw['headers'] || {}
          if (loc = redirect_location(sw['status'].to_i, sw_headers))
            next_url = carry_fragment(url, resolve_location(loc, url))
            if [307, 308].include?(sw['status'].to_i)
              return navigate_post(next_url, body, content_type, depth: depth + 1, referer: referer, referrer_policy: referrer_policy, initiator: initiator, site_seed: nav_site,
                                   origin_null: redirect_taints_origin?(origin_null, initiator, url, next_url))
            end

            return navigate(next_url, depth: depth + 1, referer: referer, referrer_policy: referrer_policy, initiator: initiator, site_seed: nav_site)
          end
          return download_in_place(url, sw_headers, [Base64.decode64(sw['body_b64'].to_s)]) if download_response?(sw_headers)
          @current_url = url
          record_response(sw['status'] || 200, sw_headers)
          boot_response_into_ctx(Base64.decode64(sw['body_b64'].to_s))
          return
        end
        env = rack_env_for(url, method: 'POST', input: body)
        # Top-level form-submission Fetch metadata — same model as `navigate` (the
        # SameSite gate reads it; a POST never qualifies for the Lax exception;
        # `nav_site` precomputed above).
        env['HTTP_SEC_FETCH_MODE'] ||= 'navigate'
        env['HTTP_SEC_FETCH_DEST'] ||= 'document'
        env['HTTP_SEC_FETCH_SITE'] ||= nav_site
        env['CONTENT_TYPE']   = content_type.empty? ? 'application/x-www-form-urlencoded' : content_type
        env['CONTENT_LENGTH'] = body.bytesize.to_s
        apply_default_request_env(env, referer: hop_referer)
        # (…and its initiating document's origin, as every POST navigation carries it — 'null' where that is opaque or a
        # redirect has tainted it, none where the initiator is unknown: `navigation_request_headers`)
        env['HTTP_ORIGIN'] = (!origin_null && url_origin(initiator)) || 'null' if initiator && !initiator.to_s.empty?
        response = dispatch_rack_or_http(url, env, method: 'POST', body: body) or return commit_error_document(url)
        status, headers, resp_body = response
        merge_set_cookie(headers, url, env)
        if (loc = redirect_location(status, headers))
          next_url = resolve_location(loc, url)
          resp_body.close if resp_body.respond_to?(:close)
          # Fetch "HTTP-redirect fetch": a 301 / 302 / 303 of a POST makes it a GET; a 307 / 308 keeps the method and
          # the body.
          if Native.redirect_to_get(status.to_i, 'POST')
            return navigate(next_url, depth: depth + 1, referer: referer, referrer_policy: referrer_policy, initiator: initiator, site_seed: nav_site)
          else
            return navigate_post(next_url, body, content_type, depth: depth + 1, referer: referer, referrer_policy: referrer_policy, initiator: initiator, site_seed: nav_site,
                                 origin_null: redirect_taints_origin?(origin_null, initiator, url, next_url))
          end
        end
        return download_in_place(url, headers, resp_body) if download_response?(headers)
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

      # Spawn a background thread that will call into the host Rack app, registered
      # for the session-boundary drain. Spawn and registration share one critical
      # section so the thread's ensure-side deregistration can never run first.
      # Anything escaping the body — a fire-and-forget thread has nowhere to report
      # it — is contained here so a later `join` can't re-raise it into `reset!`.
      private def spawn_app_request_thread(&body)
        # (…a request a worker's thread spawned still the worker's: judged by its record, as on its own thread — a
        # keepalive fetch's cookies by its site for cookies)
        worker_record = Thread.current[:csim_worker_record]
        @app_request_lock.synchronize do
          thread = Thread.new do
            begin
              Thread.current[:csim_worker_record] = worker_record
              body.call
            rescue Exception => e
              warn "[capybara-simulated] background app request thread died: #{e.class}: #{e.message}"
            ensure
              @app_request_lock.synchronize { @app_request_threads.delete(Thread.current) }
            end
          end
          @app_request_threads[thread] = true
          thread
        end
      end

      # Join every registered background app-request thread (see reset! for why they
      # must not cross the session boundary). A thread that outlives the budget is
      # DROPPED from the registry — one permanent wedge must cost one boundary its
      # budget, not every later one — and warned about; its own ensure tolerates the
      # early removal.
      def drain_app_request_threads
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + APP_REQUEST_DRAIN_BUDGET_S
        @app_request_lock.synchronize { @app_request_threads.keys }.each do |t|
          next if t.join([deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC), 0].max)
          @app_request_lock.synchronize { @app_request_threads.delete(t) }
          warn "[capybara-simulated] background app request still running at the session boundary (#{t.inspect})"
        end
      end

      def reset!
        # A load marked by the outgoing page's boot belongs to a document this reset
        # is discarding — firing it against the next one would be a load event for a
        # document that never loaded.
        @window_load_due = false
        @font_file_failed = nil   # a 404'd @font-face refetches on the next navigation (Chrome)
        # Background app requests must not cross the session boundary — QUIESCE them
        # before touching anything else. Diagnosed on Discourse (2026-08-22): a
        # leftover async image fetch, holding ActiveRecord's pinned-connection + pool
        # locks inside `checkout`, sat in a `PG::Connection#exec` that never returned
        # while the next example's first DB access queued behind it (live lock-owner
        # dump). The lost reply implicates a raw-socket co-user that bypasses AR's
        # per-connection lock — Discourse's mini_sql `DB.exec` in test hooks fits —
        # which is also why the harness drains again ahead of app after-hooks
        # (csim_rspec prepend_after); this reset-time drain is the driver's own
        # boundary. AR acquires those locks under
        # `Thread.handle_interrupt(Exception => :never)`, so the wedge shrugged off
        # Timeout and SIGTERM: the order-dependent 300 s example timeouts and the
        # uninterruptible suite hang were both this. Joining mirrors a real stack
        # anyway — the server finishes an aborted request; only the client-side wait
        # is discarded.
        drain_app_request_threads
        # Discard the image-load slots so a slow endpoint can't hold the NEXT test's tick
        # gates and window-load deferral open. A thread that finishes after this finds its
        # slot gone and drops the result.
        @image_load_lock.synchronize do
          @image_load_results.clear
          @image_load_flights.clear
          @image_load_pending = 0
        end
        Native.cookie_jar_clear(@cookie_jar)
        @auth_cache.clear
        Native.storage_clear(@local_storage)
        Native.session_partition_clear(@session_partition)
        Native.storage_clear(@session_storage)
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
        # A test may leave a frame switched-to without switching back
        # (Capybara's reset_session spec covers exactly this); start the
        # next test back on the main document.
        reset_frame_scope
        @history.clear
        @history_idx               = -1
        @history_before_navigation = nil
        @cors_preflight_cache = {}   # CORS-preflight cache is per browsing context
        # A JS-driven history.back()/go() that scheduled a deferred traverse but
        # never drained (the page navigated away first) must not survive the reset
        # — otherwise the stale target replays against the NEXT page's fresh history.
        @pending_history_traverse = nil
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
        reset_websockets
        @window_inbox.clear
        @broadcast_inbox.clear
        # The BroadcastChannel queue is per-page (the rebuilt VM has no live channels); a stale entry would misroute.
        @bc_queue.clear
        # Free any zero-copy transfer backing stores that went unimported
        # (worker killed before draining its inbox, etc.) before the rebuild.
        drop_pending_transfers
        Native.blob_registry_clear(@blob_window)
        # Drop volatile entries from the class-level HTTP asset cache
        # so test-local DB state (TranslationOverride, etc.) reaches
        # the app on subsequent visits. Fingerprinted assets
        # (`Cache-Control: immutable`) survive, as in a persistent browser
        # profile: their URLs are content-addressable so a stale entry can't
        # shadow a later test. (The still-fresh script / stylesheet source memo
        # `@@asset_src` and the @font-face files survive too — see there.) A test
        # that needs the cold cache a fresh Playwright / Cuprite context starts
        # with (its app reuses an immutable URL for new bytes) asks for it with
        # `Driver#clear_http_cache`.
        @@asset_cache.clear_volatile
        @runtime.reset_page
        # Per-visit ctx rebuild drops the JS-side trace-active flag,
        # so re-flip it if we're carrying a pending trace into the
        # next visit.
        @runtime.call('__csimSetTraceActive', false)
        reset_timer_state
        invalidate_find_cache
      end

      # Tear down an auxiliary window's Browser when its window closes (the
      # Driver calls this on close_window / reset!). Releases what a bare GC of
      # the isolate would NOT: live background threads (worker / SSE / hijacked-
      # fetch / WebSocket readers) and any parked zero-copy transfer backing
      # stores this window issued (the transfer registry is process-wide). Runs
      # while the runtime is still alive so the transferDrop call lands.
      def dispose
        # (…its blob URL registry first, process-global as the transfers are — blob_registry.rs — so a teardown step
        # that raises leaves no entry another window of the session would find)
        Native.blob_window_dispose(@blob_window)
        # An aux window's background app requests are the same boundary hazard
        # reset! drains (Driver#reset! disposes aux windows BEFORE the primary's
        # reset, so without this they'd cross into the next test untouched).
        drain_app_request_threads
        drop_pending_transfers
        reset_workers
        reset_event_sources
        reset_hijacked_fetches
        reset_websockets
        @window_inbox.clear
        @broadcast_inbox.clear
        @bc_queue.clear
        # Dispose the JS runtime/isolate itself — for an auxiliary window this
        # Browser is the isolate's last owner, but dropping the last reference
        # reclaims nothing: the engine roots every attached host fn, and they
        # capture this Browser (see V8Runtime's `@@live`). Without this, each
        # closed window leaked a live V8 isolate (RSS climbed across a long
        # suite). Only reached on teardown, never on the per-test `reset!` path
        # (which keeps the runtime).
        # (…its service worker registrations first — they are this window's alone, and nothing below may skip them — and
        # its storage sheds: its sessionStorage's, and a localStorage one no driver gave it)
        Native.sw_clear(@sw_partition)
        Native.storage_clear(@session_storage)
        Native.storage_clear(@local_storage) if @local_storage_owned
        @runtime.dispose
        # …and the IndexedDB databases, caches and clipboard of a partition this window alone had (one a driver gave it is
        # the driver's).
        Native.session_partition_clear(@session_partition) if @session_partition_owned
      rescue StandardError
        nil
      end

      # ── Host-fn callbacks invoked by bridge.js ──────────────────

      # (…a mode's verdicts judged against `client_url`'s origin, a worker script's 'same-origin')
      def rack_fetch_body(url, cors_mode: nil, client_url: nil, client_origin: nil)
        result = rack_fetch('GET', url, '', {}, 'follow', cors_mode, client_url: client_url, client_origin: client_origin)
        # …the URL it was fetched from at last, its redirects followed (a worker's global scope takes it: HTML "run a worker"
        # sets its url to the response's)…
        Thread.current[:csim_asset_url] = result && result['url']
        # What the asset's Resource Timing entry reports — kept beside the cached body (see
        # `external_asset_source`), since the body alone is what the loader hands back.
        Thread.current[:csim_asset_meta] = result && resource_timing_meta(result)
        # …and whether it forbids being stored at all, which `external_asset_source`'s per-document memo honours.
        Thread.current[:csim_asset_no_store] = result && result['headers']&.any? {|k, v|
          k.to_s.casecmp?('cache-control') && Array(v).join(',').match?(/(?:\A|,)\s*no-store\s*(?:,|\z)/i)
        }
        # …and its bytes where its text is not them (a byte-order mark taken off, an encoding other than UTF-8 decoded) —
        # elsewhere they are its text's UTF-8: what a script's integrity is a digest of and its source is decoded from
        # (`external_asset_bytes`).
        raw = result && result['body_bytes']
        Thread.current[:csim_asset_bytes] = raw if raw && raw.b != result['body'].to_s.b
        # (…a script's or a style sheet's resource loads with an ok status alone, 200 to 299: HTML "fetch a classic script",
        # "fetch and process the linked resource")
        return nil unless resource_loaded?(result) && (200..299).cover?(result['status'].to_i)
        result['body'].to_s
      end

      # Whether a resource the host loads came in `result` (`rack_fetch`'s): a response, and its body whole — one the wire
      # cut short (`framed_response`) fails the load, as a network error does (Chrome and Firefox: a script's, a style
      # sheet's, an image's `error`).
      def resource_loaded?(result) = result && !result['body_error']

      # A module the graph loader just fetched (via `rack_fetch_body`, whose facts are stashed in
      # `csim_asset_meta`) — collected so the bridge can file its 'script' Resource Timing entry.
      # One per URL, as the browser files it: the loader's handle cache already skips a re-import
      # before it fetches, and the dedup here keeps that true for any path that does not.
      def note_module_fetch(url)
        meta = Thread.current[:csim_asset_meta]
        return unless meta

        url  = url.to_s
        list = (Thread.current[:csim_module_rt] ||= [])
        list << {'url' => url, 'meta' => meta} unless list.any? {|m| m['url'] == url }
      end
      # The modules fetched since the last call, for the bridge to time as 'script' — cleared on read.
      def take_module_rt
        list = Thread.current[:csim_module_rt] || []
        Thread.current[:csim_module_rt] = []
        list
      end

      # The `{url, meta}` for the worker main-script fetch the last `worker_spawn` made (or nil) —
      # the Worker / SharedWorker constructor reads it right after the spawn to file a 'other'
      # (classic) / 'script' (module) Resource Timing entry in the creating realm. Cleared on read.
      def take_worker_rt
        rt = Thread.current[:csim_worker_rt]
        Thread.current[:csim_worker_rt] = nil
        rt
      end

      # File the Resource Timing entries for any module a dynamic `import()` fetched since the last
      # drain, before a script reads `performance`. A static `<script type=module>` graph files its
      # own entries inline (see `runModuleScript`, before the element's `load`); a dynamic import has
      # no such follow-up, so this read-boundary flush is what files it — at the next driver read, so
      # every Capybara assertion on `performance` sees it. Two known gaps of this backstop, kept
      # small deliberately (the alternative — recording in the loader mid-resolution — re-enters V8
      # from the host during module resolution, which the rusty_racer rendezvous makes risky): a
      # dynamic import's entry is filed at drain time rather than fetch time, and a page that reads
      # `performance` from within the import's own `.then` (before any driver read) won't see it yet.
      # Gated on the thread-local so a module-free page never crosses into JS; routed through
      # `dom_call` so the flush runs in the active realm (a `within_frame` dynamic import read from a
      # different realm is filed there, not in the frame's `performance` — the remaining gap).
      def flush_module_rt
        return if (Thread.current[:csim_module_rt] || []).empty?

        dom_call('__csimFlushModuleRt')
      end

      # A resource fetched only for its Resource Timing entry — a `<video>` / `<audio>` / `<embed>` /
      # `<object>` / `<track>` source the driver does not otherwise decode or play. Returns the fetch
      # facts (`resource_timing_meta`), or nil when the URL can't resolve; a 4xx/5xx still returns
      # facts so the entry records, as a browser files one for a failed media load.
      def resource_timing_fetch(url, cors = false, credentials = 'same-origin')
        key = resolve_against_current(url.to_s)
        return nil unless key.is_a?(String)
        result = rack_fetch('GET', key, '', {}, 'follow', cors ? 'cors' : 'no-cors',
                            credentials: credentials, client_url: @current_url, referrer: @current_url)
        result && resource_timing_meta(result)
      end

      # The response facts a `PerformanceResourceTiming` entry is built from, without the body — and the headers a
      # script's response is refused by (its MIME type, `X-Content-Type-Options`).
      def resource_timing_meta(result)
        {
          'url'             => result['url'],
          'status'          => result['status'].to_i,
          'headers'         => %w[content-type x-content-type-options].to_h {|name|
            [name, result['headers']&.find {|k, _| k.to_s.casecmp?(name) }&.last]
          },
          'bytes'           => result['bytes'].to_i,
          'encoded'         => result['encoded'].to_i,
          'cached'          => result['cached'],
          'redirected'      => result['redirected'] == true,
          'type'            => result['type'],
          'tao'             => result['tao'],
          'serverTiming'    => result['serverTiming'],
          'contentEncoding' => result['contentEncoding']
        }
      end

      # The metadata of the asset `external_asset_source` last served for `url` (nil when it
      # never loaded).
      def external_asset_meta(url)
        needs_base = @current_url.to_s.start_with?('blob:', 'data:', 'about:')
        key = resolve_against_current(url.to_s, use_base: needs_base)
        key.is_a?(String) ? (@asset_meta ||= {})[key] : nil
      end

      # Fetch a source body and report how long it stays safely reusable per its
      # OWN response headers — an absolute freshness deadline (Time), or nil when
      # the response is not durably cacheable (no-store / no-cache / max-age=0 /
      # dynamic with no freshness). This lets a loader persist the body across
      # visits and skip the round-trip next time, driven by the server's cache
      # directives (RFC 9111 §5.2.2 / §4.2.2 heuristic) — NOT a URL-shape guess.
      # `clear_volatile` (at `reset!`) drops a non-immutable body from the asset
      # cache, but a content-hashed asset's source is content-stable while fresh,
      # so a loader's own cross-session cache can hold it for `fresh_until`. Used by
      # the external-asset cache (`external_asset_source`, scripts +
      # stylesheets); name is generic.
      def durable_source(url)
        body = rack_fetch_body(url)
        return [nil, nil] unless body
        entry = @@asset_cache.lookup(url)
        fresh_until = entry && entry.fresh? && entry.max_age ? entry.stored_at + entry.max_age : nil
        [body, fresh_until]
      end

      # Cross-visit cache of external asset bodies (classic `<script src>` bundles
      # AND linked `<link rel=stylesheet>` CSS), url → [body, fresh_until]. A
      # fresh VM per visit (`rebuild_ctx`) would otherwise re-fetch the same
      # fingerprinted app assets (avo.base.js, avo.base.css, …) on every visit — a
      # real browser HTTP-caches them once. Safety: only responses the server marks
      # durably cacheable (`fresh_until` from max-age) are stored, and these are
      # content-stable assets at content-hashed URLs (a change yields a new URL =
      # cache miss), so a stale body can't shadow a later test. Survives `reset!`
      # (that is the point — see `clear_http_cache` for the opt-out); size-capped.
      @@asset_src      = {}
      @@asset_src_lock = Mutex.new
      ASSET_SRC_MAX    = 4096

      # Decoded-image cache: SHA-256 of the encoded bytes => {'width'=>, 'height'=>,
      # 'bytes'=> packed RGBA String}. Decoding an image is the expensive
      # step, so — like the V8 bytecode cache and the parsed-stylesheet cache — we keep
      # the decoded pixels content-addressed and reuse them for every `<img>` whose
      # bytes match, across elements AND visits. The bytes themselves come through
      # `rack_fetch` on every load, so WHETHER a URL still yields the same image is the
      # HTTP cache's (RFC 9111) call, not this table's — a `no-cache` avatar that
      # changed on the server decodes afresh, and a test's new bytes at a reused URL
      # are never shadowed by a previous test's pixels. Size-capped so an app cycling
      # through many distinct images can't grow it without bound.
      @@image_cache      = {}
      @@image_cache_lock = Mutex.new
      IMAGE_CACHE_MAX    = 512

      # Cross-visit cache of @font-face font files, resolved-url → on-disk path (or nil
      # when the fetch failed). The bytes are written to a process-lifetime temp file so
      # native text (font.rs, text.rs) reads them by path. Font URLs are content-stable app
      # assets, so caching across the per-visit VM rebuild avoids re-fetching CanvasTest.ttf
      # & friends on every visit.
      @@font_file_cache      = {}
      @@font_file_lock       = Mutex.new
      @@font_files           = []   # pins the Tempfiles for the PROCESS (the cache is cross-visit)
      @@local_font_cache     = {}   # `local(<name>)` resolution — installed fonts don't change per process

      # Empty the process-wide HTTP cache: the RFC 9111 store behind `rack_fetch` plus
      # the URL-keyed memos layered on it — script / stylesheet source, @font-face
      # files, source maps. What a test gets by starting with a fresh Playwright /
      # Cuprite browser context — for an app that serves NEW bytes at a URL it marked
      # `immutable` (Discourse's colour-palette stylesheet is digested from a DB row's
      # id + version, both reused across rolled-back examples). Content-addressed caches
      # (bytecode, parsed sheets, decoded images) stay: they can't go stale. Documents
      # already loaded keep their in-memory subresources, as a browser's per-document
      # memory cache does — the next fetch is what hits the network. The font Tempfiles
      # stay pinned (`@@font_files`): a live document may still be shaping text with them.
      def self.clear_http_cache
        @@asset_cache.clear
        @@asset_src_lock.synchronize { @@asset_src.clear }
        @@font_file_lock.synchronize { @@font_file_cache.clear }
        StackResolver.clear
        nil
      end

      # Body of an external durably-cacheable asset (classic script or stylesheet),
      # served from the cross-visit cache when still fresh, else fetched (which
      # read-throughs the per-visit asset cache) and cached iff durably cacheable.
      # Returns nil on a status that is not ok (not 200 to 299) / fetch failure, so the
      # JS caller fails the load.
      # A document starts loading — the page's, a frame's, an auxiliary window's (the bridge's `__csimLoadDocument` asks,
      # and keeps the answer as `__csimDocToken`): a token of its own, naming its asset memo in `external_asset_source`.
      # The last ASSET_DOCUMENTS documents' memos are kept, so a page's survives the frames it builds while it loads.
      ASSET_DOCUMENTS = 16
      def asset_document_started
        @asset_document_seq = (@asset_document_seq || 0) + 1
        memos = (@page_asset_src ||= {})
        memos.shift while memos.size >= ASSET_DOCUMENTS
        memos[@asset_document_seq] = {}
        @asset_document_seq
      end

      def external_asset_source(url, document = nil)
        # A blob:/data:/about: document's location can't anchor an absolute-path
        # `src=/common/…` (URI.join on a `blob:` URL yields nothing usable), but its
        # `<base href>` points at a real http(s) origin — so for THOSE documents
        # resolve against `<base href>` (HTML base-tag semantics) and the script loads.
        # Ordinary http(s) pages keep the document-URL base so the hot path skips the
        # `document_base_url` dom_call (CLAUDE.md rule 3).
        needs_base = @current_url.to_s.start_with?('blob:', 'data:', 'about:')
        key = resolve_against_current(url.to_s, use_base: needs_base)
        return nil unless key.is_a?(String)
        # One fetch per URL per DOCUMENT (`document`, the asking realm's token), whatever the response's freshness says —
        # a browser's memory cache: the cascade fetches a `<link>`'s sheet and its load task asks again, and a response
        # with no cache headers (every asset of a Rails app in test) crossed Rack twice per page. `no-store` alone is
        # fetched every time, and a document that loads again — a frame reloaded — has a memo of its own.
        # (A body served from memory carries the facts of the response it came from, for whoever files its Resource
        # Timing entry — `note_module_fetch` reads them where `rack_fetch_body` would have left them.)
        memo = document && @page_asset_src&.[](document.to_i)
        if memo && (e = memo[key])
          (@asset_meta ||= {})[key] = Thread.current[:csim_asset_meta] = e[1]
          (@asset_bytes ||= {})[key] = e[2]
          return e[0]
        end
        @@asset_src_lock.synchronize do
          if (e = @@asset_src[key])
            if e[1].nil? || Time.now < e[1]
              (@asset_meta ||= {})[key] = Thread.current[:csim_asset_meta] = e[2]
              (@asset_bytes ||= {})[key] = e[3]
              return e[0]
            end
            @@asset_src.delete(key)
          end
        end
        # `durable_source` already does the spec-compliant fetch + header-driven
        # freshness (RFC 9111 max-age → absolute deadline); reuse it instead of
        # re-deriving `fresh_until` here.
        Thread.current[:csim_asset_meta] = Thread.current[:csim_asset_bytes] = nil
        body, fresh_until = durable_source(key)
        meta = Thread.current[:csim_asset_meta]
        (@asset_meta ||= {})[key] = meta
        return nil unless body
        # Script / stylesheet source is TEXT, but the raw Rack / binread body
        # arrives BINARY-tagged (see `RuntimeShared.utf8_text`). (…its bytes kept beside it where the text is not them:
        # `rack_fetch_body`)
        text  = RuntimeShared.utf8_text(body)
        bytes = Thread.current[:csim_asset_bytes] || (body.b if text.b != body.b)
        (@asset_bytes ||= {})[key] = bytes
        memo[key] = [text, meta, bytes] if memo && !Thread.current[:csim_asset_no_store]
        if fresh_until
          @@asset_src_lock.synchronize do
            @@asset_src.clear if @@asset_src.size >= ASSET_SRC_MAX
            @@asset_src[key] = [text, fresh_until, meta, bytes]
          end
        end
        text
      end

      # The bytes of the asset `external_asset_source` last served for `url` where its text is not them (nil where they
      # are its text's UTF-8): what a script's integrity check hashes and its source is decoded from.
      def external_asset_bytes(url)
        needs_base = @current_url.to_s.start_with?('blob:', 'data:', 'about:')
        key = resolve_against_current(url.to_s, use_base: needs_base)
        key.is_a?(String) ? @asset_bytes&.[](key) : nil
      end

      # Native ESM entry point: `Context#compile_module` +
      # `Module#instantiate` / `#evaluate` + `Context#dynamic_import_resolver=`.
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
      # rusty_racer VMs are single-threaded; only the main
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
        # (…each a task of its own — see deliver_window_messages)
        events.each {|event| @runtime.call('__csim_deliverEventSourceEvents', [event]) }
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
        socket = nil
        # Fetch with redirect mode "follow": a 3xx with a Location is followed, re-resolved against the URL it came from,
        # up to the redirect limit — an HTTP(S) one alone, each hop its own cookies.
        (MAX_FETCH_REDIRECTS + 1).times do
          uri = uri_for(target)
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
          content_types = []
          set_cookies   = []
          location      = nil
          while (line = socket.gets) && line.strip != ''
            chunked = true if line =~ /\Atransfer-encoding:\s*chunked/i
            raw = line.split(':', 2)[1].to_s.strip
            # (…a Content-Type's bytes each one character, as Fetch reads a header — a non-ASCII byte a Latin-1 one; a
            # Location UTF-8, as the URL parser takes it, Latin-1 where it is none)
            content_types << raw.dup.force_encoding(Encoding::ISO_8859_1).encode(Encoding::UTF_8) if line =~ /\Acontent-type:/i
            set_cookies << raw.b if line =~ /\Aset-cookie:/i   # (…its bytes, as the store keeps them)
            if line =~ /\Alocation:/i
              utf8     = raw.dup.force_encoding(Encoding::UTF_8)
              location = utf8.valid_encoding? ? utf8 : raw.dup.force_encoding(Encoding::ISO_8859_1).encode(Encoding::UTF_8)
            end
          end
          # (…a hop's cookies kept before the next is asked for: a login bounce sets one the stream needs)
          merge_set_cookie({'set-cookie' => set_cookies}, target) unless set_cookies.empty?
          if REDIRECT_STATUSES.include?(code) && location
            socket.close
            target = carry_fragment(target, resolve_against(location, target))
            next
          end
          # HTML "establish the connection": a response that is not a 200 of `text/event-stream` fails it — no
          # reconnection.
          unless code == 200 && Native.content_type_essence(content_types.join(', ')) == 'text/event-stream'
            queue << {id: id, type: '__error', message: "HTTP #{code} #{content_types.join(', ')}".strip}
            return
          end
          queue << {id: id, type: '__open'}
          read_event_source_body(socket, id, queue, chunked: chunked)
          return
        end
        queue << {id: id, type: '__error', message: 'too many redirects'}
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
        # Forward the streaming host's cookie jar so the server can
        # authenticate the user the same way the browser would — scoped to
        # the EventSource target's host, like every other request.
        cookies = cookie_header_for(uri.to_s, secure: uri.scheme == 'https' || secure_cookie_channel?(uri.to_s))
        lines << "Cookie: #{cookies}" unless cookies.empty?
        socket.write(lines.join("\r\n") << "\r\n\r\n")
        socket.flush
      end

      # The stream's events as its chunks come, by HTML's "interpret an event stream" (the engine's, the page's too) — a
      # parser kept from chunk to chunk, so a record or a line a chunk ends in the middle of goes on in the next.
      private def read_event_source_body(socket, id, queue, chunked:)
        parser = Native.event_stream_open
        loop do
          if chunked
            size_line = socket.gets
            break unless size_line
            size = size_line.strip.to_i(16)
            break if size.zero?
            chunk = socket.read(size).to_s
            socket.read(2)  # trailing CRLF
          else
            chunk = socket.readpartial(4096)
          end
          Native.event_stream_feed(parser, chunk).each {|type, data, event_id| queue << {id: id, type: type, data: data, lastEventId: event_id} }
        end
      ensure
        Native.event_stream_close(parser) if parser
      end

      def reset_event_sources
        @event_source_threads.each_value(&:kill)
        @event_source_threads.clear
        @event_source_queue.clear
      end

      # ── WebSocket (RFC6455 over in-process rack.hijack) ────────────
      #
      # A real browser's WebSocket connects, upgrades, and stays open for
      # bidirectional framing. Action Cable (and any Rack WebSocket
      # middleware) handles the upgrade by HIJACKING the connection and
      # speaking frames over that socket — the same in-process `rack.hijack`
      # mechanism the long-poll path already uses, but bidirectional. So we:
      #   1. build the upgrade request as a Rack env (the server reads the
      #      handshake from the env, like websocket-driver's rack helper),
      #   2. hand the app a `Socket.pair` end via `rack.hijack` and call it,
      #   3. the app writes the 101 + frames to its end; we read/write ours.
      # The frame reader runs on a background thread (engine access stays on
      # the main thread — events drain into the VM at `settle`, like SSE).
      WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
      private_constant :WS_GUID
      # The worker a WebSocket was opened in: its reader's events go to the worker's inbox, which the worker's own loop
      # delivers into its isolate (`run_worker`) — the main thread's queue is the window's alone — and its handshake
      # comes from the worker's URL.
      WsWorker = Struct.new(:handle, :inbox, :url) do
        def <<(event) = (inbox << {kind: 'ws', event: event})
      end
      private_constant :WsWorker

      # (`worker`: the WsWorker that opens it — none for the window's)
      def ws_open(url, protocols = nil, worker = nil)
        queue    = worker || @websocket_queue
        client   = worker ? worker.url : @current_url
        id       = @websocket_lock.synchronize { @websocket_seq += 1 }
        # ws:// → http://, wss:// → https:// for the Rack env; resolve relative
        # against the current document (Action Cable's consumer builds an
        # absolute ws URL, but be tolerant).
        http_url = url.to_s.sub(/\Awss/i, 'https').sub(/\Aws/i, 'http')
        target   = resolve_against_current(http_url)
        key      = SecureRandom.base64(16)
        csim_io, app_io = Socket.pair(:UNIX, :STREAM, 0)
        env = rack_env_for(target, method: 'GET')
        apply_default_request_env(env, referer: client)
        env['HTTP_UPGRADE']               = 'websocket'
        env['HTTP_CONNECTION']            = 'Upgrade'
        env['HTTP_SEC_WEBSOCKET_KEY']     = key
        env['HTTP_SEC_WEBSOCKET_VERSION'] = '13'
        # The opening handshake always carries its client's origin — the document's, or the worker's (the UA owns this
        # header) — server handlers echo it back (websockets/opening-handshake origin test). A blob: client's is the
        # origin its URL carries inside; a data: worker's is opaque, and goes unsent.
        client_origin = url_origin(client.to_s.delete_prefix('blob:'))
        env['HTTP_ORIGIN'] = client_origin if client_origin
        list = Array(protocols).map(&:to_s).reject(&:empty?)
        env['HTTP_SEC_WEBSOCKET_PROTOCOL'] = list.join(', ') unless list.empty?
        env['rack.hijack?']  = true
        env['rack.hijack']   = -> { app_io }
        env['rack.hijack_io'] = app_io
        # The app hijacks + writes the 101 (synchronously, or on its own event
        # loop thread — Action Cable handles the upgrade on a separate thread, so
        # `@app.call` may return before the handshake bytes appear; the reader
        # blocks until they do). Called on the opener's thread — the main thread's
        # for the window, a worker's own for its sockets, as its `fetch` calls the app.
        # (No handshake timeout: a server that never writes the 101 leaks the
        # reader+socket until its teardown — acceptable, real servers always respond.)
        @app.call(env)
        accept = Digest::SHA1.base64digest(key + WS_GUID)
        @websocket_lock.synchronize do
          @websocket_sockets[id]     = csim_io
          @websocket_app_sockets[id] = app_io
          @websocket_workers[id]     = worker.handle if worker
          @websocket_threads[id] = Thread.new do
            Thread.current.report_on_exception = false
            run_websocket_reader(id, csim_io, accept, queue, target)
          end
        end
        id
      rescue StandardError => e
        # Nothing was registered for cleanup yet — close both pair ends here so
        # a failed upgrade (mis-routed URL, app error) doesn't leak fds.
        csim_io.close rescue nil
        app_io.close  rescue nil
        queue << {id: id, type: '__error', message: "#{e.class}: #{e.message}"}
        id
      end

      # `binary` is set by the JS side (it knows whether `send` was given a
      # string or an ArrayBuffer/view) → opcode 0x2 vs the text 0x1. Action
      # Cable is text-only (JSON).
      def ws_send(id, data, binary = false)
        sock = @websocket_lock.synchronize { @websocket_sockets[id.to_i] } or return
        ws_write_frame(sock, binary ? 0x2 : 0x1, data.to_s.b)
        nil
      rescue StandardError
        nil
      end

      # (`hold`: the window's close holds the clock — a worker's, delivered by its own loop, does not)
      def ws_close(id, code = nil, reason = '', hold: true)
        sock = @websocket_lock.synchronize { @websocket_sockets[id.to_i] } or return
        # Send the close frame and let the close HANDSHAKE complete: the server
        # replies with its own close frame, which the reader thread surfaces as
        # the `__close` event (carrying the agreed code) before tearing the
        # socket down in its `ensure`. Force teardown is `reset_websockets`'s job.
        # A nil code sends a BODYLESS close frame — `ws.close()` with no argument
        # closes with no status, which the peer echoes and the reader reports as
        # code 1005 (NO_STATUS), not 1000.
        payload = code.nil? ? ''.b : [code.to_i].pack('n') + reason.to_s.b
        ws_write_frame(sock, 0x8, payload) rescue nil
        # A close handshake is now in flight — hold the clock until the reader's `__close` lands
        # (bounded by the deadline in hold_for_ws_close if the peer never replies → EOF 1006).
        @ws_close_pending += 1 if hold
        nil
      end

      # Pending WS work = queued reader events OR an in-flight `ws.close()` whose `__close` hasn't
      # landed yet. Counting the latter keeps every advance path (settle, tick_real_time, and
      # crucially horizon_fast_forward_step, which would otherwise jump straight to a test's pending
      # timeout timer) from racing past the close handshake before hold_for_ws_close delivers it.
      def websocket_pending? = !@websocket_queue_head.nil? || !@websocket_queue.empty? || @ws_close_pending.positive?

      # A live reader thread = an open WS connection whose server may still surface an echo / push /
      # close frame off-thread — pending async work the JS event-loop probe can't see. The event-loop
      # frame reports it as `async` so the WPT drain loop yields the GVL each frame (its
      # `sleep(0.001) if async`), feeding the reader instead of spinning it into starvation — a
      # binary echo that only lands AFTER the idle-bail is exactly the flake this prevents. Zero-alloc
      # on the common no-WS path (the `empty?` short-circuit); a handful of threads otherwise.
      # (A dropped socket's reader, finishing a closing handshake nobody hears, is no work of the page's.)
      def websocket_reader_active? = !@websocket_threads.empty? && @websocket_lock.synchronize { @websocket_threads.any? {|id, t| @websocket_sockets.key?(id) && t.alive? } }

      # Any live cross-thread actor (a worker / service-worker thread, or a WebSocket
      # reader) — the only things that can revive an apparently-idle page from OUTSIDE
      # the JS event loop. The WPT runner's post-idle-bail grace window gates on this,
      # so the plain-DOM majority of files never pays the real-time wait.
      def cross_thread_actors? = @workers.any? {|_h, w| w[:thread]&.alive? } || websocket_reader_active?

      def deliver_websocket_events
        return 0 if @websocket_threads.empty? && @websocket_queue_head.nil? && @websocket_queue.empty?
        # The head slot (parked by hold_for_ws_close) is delivered ahead of the queue to preserve
        # reader order.
        events = [@websocket_queue_head].compact
        @websocket_queue_head = nil
        events.concat(drain_queue(@websocket_queue))
        return 0 if events.empty?
        # `__setcookie` is handled Ruby-side (store the handshake cookie in the jar) and NOT
        # forwarded to JS; the reader queues it before `__open`, so document.cookie sees it in onopen.
        js_events = events.reject do |e|
          if e[:type] == '__setcookie'
            merge_set_cookie({'set-cookie' => e[:cookies]}, e[:url])
            true
          end
        end
        # (…each a task of its own — see deliver_window_messages)
        js_events.each {|event| @runtime.call('__csim_deliverWebSocketEvents', [event]) }
        # A terminal event (`__close` / `__error`) completes a close handshake — release the clock
        # hold. Clamp: a server-INITIATED close arrives without a matching ws_close increment.
        terminals = events.count {|e| e[:type] == '__close' || e[:type] == '__error' }
        @ws_close_pending = [@ws_close_pending - terminals, 0].max if terminals.positive?
        events.size
      end

      def reset_websockets
        @websocket_lock.synchronize do
          @websocket_threads.each_value(&:kill)
          @websocket_threads.clear
          # Close BOTH pair ends: csim's read/write end and the app's hijack end
          # (the app may abandon its end without closing it — e.g. its connection
          # thread was just killed), so neither leaks across tests.
          @websocket_sockets.each_value     {|s| s.close rescue nil }
          @websocket_app_sockets.each_value {|s| s.close rescue nil }
          @websocket_sockets.clear
          @websocket_app_sockets.clear
          @websocket_workers.clear
        end
        forget_window_websocket_events
      end

      # The window's sockets, as its document goes (a navigation commits another): each made to disappear, and what
      # its readers had queued for the document gone with it.
      private def drop_document_websockets
        ws_drop_client
        forget_window_websocket_events
      end

      private def forget_window_websocket_events
        @websocket_queue.clear
        @websocket_queue_head   = nil
        @ws_close_pending       = 0
        @ws_close_wait_deadline = nil
      end

      # The sockets of a client that went away — a worker that ended, or the window's document a navigation replaced:
      # each made to disappear (HTML "unloading document cleanup steps" / a worker's teardown), its closing handshake
      # started as Going Away. Its reader finishes the handshake — torn down here, the app's reply raced csim's
      # closing end — but unheard: the socket is no longer its client's (WsHeard). (`worker`: the handle; none for the
      # window's)
      private def ws_drop_client(worker = nil)
        @websocket_lock.synchronize do
          @websocket_sockets.keys.select {|id| @websocket_workers[id] == worker }.each do |id|
            @websocket_workers.delete(id)
            ws_write_frame(@websocket_sockets.delete(id), 0x8, [1001].pack('n')) rescue nil
          end
        end
      end

      # A reader's events, while its socket is its client's (`ws_drop_client`).
      WsHeard = Struct.new(:queue, :heard) do
        def <<(event) = (queue << event if heard.call)
      end
      private_constant :WsHeard

      # Background-thread frame reader: verify the 101 handshake, then loop
      # decoding server→client frames into queue events until close / EOF.
      private def run_websocket_reader(id, sock, expected_accept, client_queue, target)
        queue = WsHeard.new(client_queue, -> { @websocket_lock.synchronize { @websocket_sockets.key?(id) } })
        ok, protocol, cookies = ws_read_handshake(sock, expected_accept)
        unless ok
          queue << {id: id, type: '__error', message: 'websocket handshake failed'}
          return
        end
        # Store any handshake-response cookies (the main thread does the store) BEFORE `open` fires,
        # so a document.cookie read in `onopen` sees them.
        queue << {id: id, type: '__setcookie', cookies: cookies, url: target} unless cookies.empty?
        # Carry the negotiated subprotocol — Action Cable's client closes the
        # connection in its `onopen` unless `webSocket.protocol` is one it knows
        # (`actioncable-v1-json`).
        queue << {id: id, type: '__open', protocol: protocol}
        loop do
          frame = ws_read_message(sock, queue, id)
          if frame.nil?                             # TCP closed with no close frame → abnormal
            queue << {id: id, type: '__close', code: 1006, reason: ''}
            break
          end
          if frame == :protocol_error               # reserved opcode / malformed frame → fail the connection
            queue << {id: id, type: '__error', message: 'protocol error'}
            break
          end
          opcode, payload = frame
          if opcode == :close
            code   = payload.bytesize >= 2 ? payload[0, 2].unpack1('n') : 1005
            reason = payload.bytesize > 2 ? RuntimeShared.utf8_text(payload[2..]) : ''
            queue << {id: id, type: '__close', code: code, reason: reason}
            break
          end
          # Binary frames cross to JS as raw bytes (a BINARY String marshals to a
          # Uint8Array) tagged so the JS side decodes them per `binaryType`; text is UTF-8.
          if opcode == 0x2
            queue << {id: id, type: 'message', binary: true, data: payload}
          else
            queue << {id: id, type: 'message', data: RuntimeShared.utf8_text(payload)}
          end
        end
      rescue StandardError => e
        queue << {id: id, type: '__close', code: 1006, reason: e.message.to_s[0, 120]}
      ensure
        # Only the socket (a local) is closed here — the `@websocket_*` hashes are
        # its opener's and its teardown's, under `@websocket_lock`; a closed entry
        # just no-ops on the next access.
        sock.close rescue nil
      end

      # Read + validate the 101 Switching Protocols response (status line +
      # headers up to the blank line). Returns `[accept_ok, negotiated_protocol]`
      # — the accept hash must match the handshake key, and the negotiated
      # `Sec-WebSocket-Protocol` (nil if none) is surfaced so `webSocket.protocol`
      # is set (Action Cable's client requires `actioncable-v1-json`).
      private def ws_read_handshake(sock, expected_accept)
        status = sock.gets
        return [false, nil, []] unless status && status =~ %r{\AHTTP/1\.1 101}i
        accept_ok = false
        protocol  = nil
        cookies   = []
        while (line = sock.gets)
          line = line.chomp
          break if line.empty?
          k, v = line.split(':', 2)
          next unless k
          key = k.strip.downcase
          val = v.to_s.strip
          accept_ok = true if key == 'sec-websocket-accept'   && val == expected_accept
          # utf8_text: socket reads are BINARY, and a BINARY string marshals to a
          # JS Uint8Array — the protocol must reach JS as a real string so
          # `webSocket.protocol` compares equal to `actioncable-v1-json`.
          protocol  = RuntimeShared.utf8_text(val) if key == 'sec-websocket-protocol' && !val.empty?
          # Cookies the server sets on the handshake response are stored in the jar (the main thread
          # does the actual store — see deliver_websocket_events), so document.cookie / the next
          # request's Cookie header reflect them.
          cookies << RuntimeShared.utf8_text(val) if key == 'set-cookie' && !val.empty?
        end
        [accept_ok, protocol, cookies]
      end

      # Read one complete message (reassembling continuation frames), handling
      # interleaved control frames inline. Returns `[opcode, payload]` (opcode
      # 0x1 text / 0x2 binary), `[:close, payload]`, `:protocol_error` (a reserved
      # opcode — the connection must be failed), or nil on EOF.
      private def ws_read_message(sock, queue, id)
        data       = +''.b
        msg_opcode = nil
        loop do
          hdr = ws_read_n(sock, 2) or return nil
          b0, b1 = hdr.bytes
          fin    = (b0 & 0x80) != 0
          opcode = b0 & 0x0f
          masked = (b1 & 0x80) != 0
          len    = b1 & 0x7f
          if len == 126
            ext = ws_read_n(sock, 2) or return nil
            len = ext.unpack1('n')
          elsif len == 127
            ext = ws_read_n(sock, 8) or return nil
            len = ext.unpack1('Q>')
          end
          mask = nil
          if masked
            mask = ws_read_n(sock, 4) or return nil
          end
          if len.zero?
            payload = ''.b
          else
            payload = ws_read_n(sock, len) or return nil
          end
          payload = ws_mask(payload, mask) if mask  # server frames shouldn't be masked, but be defensive
          case opcode
          when 0x8 then return [:close, payload]
          when 0x9 then ws_write_frame(sock, 0xA, payload); next   # ping → pong
          when 0xA then next                                       # pong → ignore
          when 0x0 then data << payload                            # continuation
          when 0x1, 0x2 then msg_opcode = opcode; data << payload  # text / binary
          else return :protocol_error                              # reserved opcode (0x3-7, 0xB-F) → fail
          end
          return [msg_opcode || opcode, data] if fin
        end
      end

      # Read exactly `n` bytes, or nil if the stream ends first (EOF, or a short
      # read on a mid-frame close). `IO#read(n)` blocks for n bytes on a stream
      # socket and only returns nil / fewer at EOF, so a nil-or-short result is
      # a closed/broken connection — bail and let the caller surface a close.
      private def ws_read_n(sock, n)
        buf = sock.read(n)
        buf if buf && buf.bytesize == n
      end

      # Write one frame. Client→server frames MUST be masked (RFC6455 §5.3);
      # csim is always the client, so every frame it writes is masked. Holds the
      # per-connection write lock so the reader thread's pong and the main
      # thread's send/close can't interleave bytes on the shared socket.
      private def ws_write_frame(sock, opcode, payload)
        payload = payload.to_s.b
        len     = payload.bytesize
        out     = [0x80 | opcode].pack('C')
        if len < 126
          out << [0x80 | len].pack('C')
        elsif len < 65_536
          out << [0x80 | 126, len].pack('Cn')
        else
          out << [0x80 | 127, len].pack('CQ>')
        end
        key = SecureRandom.random_bytes(4)
        out << key
        out << ws_mask(payload, key)
        @websocket_write_lock.synchronize { sock.write(out) }
      end

      private def ws_mask(payload, key)
        kb = key.bytes
        payload.bytes.each_with_index.map {|byte, i| byte ^ kb[i & 3] }.pack('C*')
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
      # Returns a response hash or nil for a network error (immediate — middleware didn't
      # hijack) or a `{'handle' => N}` token (deferred — middleware
      # hijacked the connection and a background thread is reading
      # the pipe). The JS-side XHR checks the return shape to pick
      # between inline processing and waiting for `__csim_
      # deliverHijackedFetches`.
      def rack_fetch_async(method, url, body, headers_json, credentials: 'same-origin', client_url: nil, client_origin: nil, client_realm: nil)
        headers = begin
          JSON.parse(headers_json.to_s)
        rescue JSON::ParserError
          {}
        end
        # `rack_fetch` already handles redirects, cookie merge, the asset cache shortcut and download detection — an async
        # XHR stays on that single source of truth, its Rack call offered `rack.hijack` as a server (Puma) offers every
        # request: middleware that takes it holds the connection open until something publishes through it (a long poll),
        # and one that does not answers as it would anyway.
        # (…the pipe read from the moment the middleware takes it, so a write larger than the pipe holds never blocks it)
        id = (@hijack_fetch_seq += 1)
        hijacked = false
        env_extras = {
          'rack.hijack?' => true,
          'rack.hijack'  => lambda {
            read_io, write_io = IO.pipe
            hijacked = true
            @hijack_fetch_threads[id] = Thread.new do
              Thread.current.report_on_exception = false
              run_hijacked_pipe_read(id, read_io, @hijack_fetch_queue)
            end
            write_io
          }
        }
        Thread.current[:csim_fetch_env] = nil
        # (…a CORS request as an XHR's is, by its client)
        resp = rack_fetch(method, url, body, headers, 'follow', 'cors', credentials: credentials, env_extras: env_extras, client_url: client_url,
                          client_origin: client_origin, client_realm: client_realm)
        # (…nil, a network error, as `rack_fetch` answers one)
        return resp unless hijacked
        # (…of the hop that hijacked it — a redirect's target where one came first — whose URL the response is)
        env = Thread.current[:csim_fetch_env] || {}
        cookie_env = env.slice('csim.cookie_site', 'csim.cookie_cross_site', 'csim.cookie_top_level', 'HTTP_SEC_FETCH_SITE', 'HTTP_SEC_FETCH_MODE', 'HTTP_SEC_FETCH_DEST')
        requested = resolve_against_current(url.to_s).to_s
        query = env['QUERY_STRING'].to_s
        # (…as text: an env's values may be BINARY-tagged, and a binary string crosses to the page as bytes)
        answered = env.empty? ? requested : RuntimeShared.utf8_text(env_request_url(env) + (query.empty? ? '' : "?#{query}"))
        # (…the request's own where no redirect led elsewhere — an env keeps no empty query's `?`)
        answered = requested if answered == requested.chomp('?')
        @hijack_fetch_contexts[id] = {url: answered, redirected: answered != requested, credentials: credentials, cookie_env: cookie_env, realm: client_realm.to_i}
        {'handle' => id}
      end

      def rack_fetch_async_abort(id)
        thread = @hijack_fetch_threads.delete(id.to_i)
        thread&.kill
        @hijack_fetch_contexts.delete(id.to_i)
        nil
      end

      def hijack_fetch_pending? = !@hijack_fetch_threads.empty? || !@hijack_fetch_queue.empty?

      # Each hijacked response, as `rack_fetch` would have answered it — its Set-Cookie stored (by the request's cookie
      # context), its body shaped as any response's (`response_hash`: text, or bytes beside it) — or a network error (nil)
      # where reading it failed: delivered to the realm whose XHR made it, a frame's included; none to a realm gone.
      def deliver_hijacked_fetches
        return 0 if @hijack_fetch_threads.empty? && @hijack_fetch_queue.empty?
        raw = drain_queue(@hijack_fetch_queue)
        return 0 if raw.empty?
        by_realm = Hash.new {|h, k| h[k] = [] }
        raw.each do |r|
          context = @hijack_fetch_contexts.delete(r['handle']) or next
          response =
            unless r['error']
              merge_set_cookie(r['headers'], context[:url], context[:cookie_env]) unless context[:credentials] == 'omit'
              response_hash(r['status'], r['headers'], r['body'], context[:url], context[:redirected])
            end
          by_realm[context[:realm]] << {'handle' => r['handle'], 'response' => response}
        end
        by_realm.each do |realm, responses|
          if realm.zero? then @runtime.call('__csim_deliverHijackedFetches', responses)
          elsif @runtime.frame_realm_alive?(realm) then @runtime.realm_call(realm, '__csim_deliverHijackedFetches', responses)
          end
        end
        raw.size
      end

      def reset_hijacked_fetches
        @hijack_fetch_threads.each_value(&:kill)
        @hijack_fetch_threads.clear
        @hijack_fetch_queue.clear
        @hijack_fetch_contexts.clear
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
        queue << {'handle' => id, 'error' => "#{e.class}: #{e.message}"}
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
            # Slices of the BINARY socket buffer (see `RuntimeShared.utf8_text`) — a repeated one's values combined:
            # Set-Cookie's a line each, as `merge_set_cookie` reads them, any other's with `, ` (Fetch's "combine").
            k = RuntimeShared.utf8_text(k)
            v = RuntimeShared.utf8_text(v)
            headers[k] = headers.key?(k) ? [headers[k], v].join(k == 'set-cookie' ? "\n" : ', ') : v
          end
        end
        # (…the body as its bytes — decoded at delivery as any response's is — a chunked one's chunks joined)
        body = body.to_s.b
        if headers['transfer-encoding'].to_s.downcase.include?('chunked')
          headers.delete('transfer-encoding')
          body = dechunk_http_body(body)
        end
        {'status' => status, 'headers' => headers, 'body' => body}
      end

      # An HTTP/1.1 chunked body's chunks, joined: each a hex size line and its bytes, up to the zero-size one (RFC 9112
      # §7.1; its trailers dropped).
      private def dechunk_http_body(raw)
        out = String.new(encoding: Encoding::BINARY)
        pos = 0
        while (eol = raw.index("\r\n", pos))
          size = raw[pos...eol].split(';', 2).first.to_s.strip.to_i(16)
          break if size.zero?
          out << raw.byteslice(eol + 2, size).to_s
          pos = eol + 2 + size + 2
        end
        out
      end

      # ── Web Workers ────────────────────────────────────────────────
      #
      # `new Worker(url)` in JS lands in `worker_spawn`. The Ruby
      # thread it spawns owns a fresh V8 Context (true
      # isolate, separate microtask queue and timer table), evals the
      # worker script there, and runs an event loop draining timers,
      # microtasks, and the inbox queue from the main thread. Each
      # worker's `__csim_workerPostMessage` host fn closes over its
      # handle and routes outgoing messages onto a shared outbox the
      # main settle drains.
      def worker_spawn(url, shared: false, service: false, creator_key: nil, realm_id: 0, controller_handle: 0, sw_scope: nil, script_type: nil, update_via_cache: nil, name: '')
        # A NEGATIVE realm_id is the worker-parent convention (a NESTED worker — `new
        # Worker` inside a worker isolate tags -(its own handle)): the spawn runs on the
        # PARENT WORKER's thread, so record the creator, route the child's messages back
        # through the parent's isolate, and die with it (worker_terminate cascade).
        parent_worker = realm_id.to_i.negative? ? -realm_id.to_i : nil
        # The handle counter is bumped from worker threads too (nested spawns) — lock it.
        handle = @worker_init_lock.synchronize { @worker_seq += 1 }
        # Clear any Resource Timing fact a preceding spawn left, so an early `worker_fail` below (which
        # still returns a handle the JS registers) can't hand its constructor a stale entry.
        Thread.current[:csim_worker_rt] = nil
        # A NESTED blob:/data: worker script would need the MAIN VM's blob registry from a
        # non-owning thread (the documented SEGV hazard) — fail it cleanly (onerror), the
        # same observable as before nested workers existed. Marshalling the blob read to
        # the main thread is the follow-up that lifts this.
        if parent_worker && url.to_s.match?(/\A(blob|data):/i)
          return worker_fail(handle, 'Nested workers with blob:/data: scripts are not supported')
        end
        target = parent_worker ? url.to_s : resolve_against_current(url.to_s)
        # A worker script from a blob: URL in a DIFFERENT storage partition than this
        # context can't be created (cross-partition-worker-creation): the worker would
        # run in the creating context's partition, not the blob's. Deliver an error so
        # Worker/SharedWorker fires `onerror`, and spawn no thread. The handle is still
        # >0 so the JS registers the worker and the queued __error reaches it.
        if target.start_with?('blob:') && @driver.respond_to?(:cross_partition_blob?) && @driver.cross_partition_blob?(target, self)
          return worker_fail(handle, 'Worker creation from a cross-partition blob URL is blocked')
        end
        inbox  = Thread::Queue.new
        outbox = @worker_outbox
        # This worker's controlling SW (a dedicated/shared worker is a CLIENT: scope match on
        # its script URL, or the creator's controller for an opaque blob:/data: script).
        # Computed once here on the registry-owning thread; run_worker installs it into the
        # isolate and the registry records it below.
        ctrl = service ? 0 : worker_controller_handle(target, shared, controller_handle).to_i
        # A worker whose MAIN SCRIPT a fetch-handling SW controls fetches it THROUGH that SW
        # (worker-client-id: the SW synthesizes the script), deferred to run_worker
        # (`body: nil` + `sw_script:`) — the spawn runs inside a JS host callback where a
        # synchronous wait deadlocks (the documented worker-interception lesson). While the
        # deferred fetch runs, @worker_initializing keeps the drain loops pumping
        # (worker_drive_pending?); the runner's post-idle-bail grace window covers the
        # POST-init autonomous worker work the counters can't see.
        sw_script = !service && target.match?(%r{\Ahttps?://}i) ? sw_controller_for_navigation(target) : nil
        # Resolve the worker script body on the main thread before
        # handing off to the worker. `blob:` URLs need the main VM's
        # blob registry; calling into the main runtime from a
        # non-owning thread SEGVs (V8 isolates are thread-
        # bound).
        # A registration UPDATE parked the bytes it fetched and byte-checked
        # (sw_registration_update_fetch) — the new version runs exactly those. The
        # import PROBE results ride along as its script resource map (importScripts
        # consume them instead of re-fetching — a 404 the byte-check saw stays a 404).
        pending_imports = service ? (@sw_scope_meta[sw_scope.to_s] || {}).delete(:pending_imports) : nil
        body = if service && (pending = (@sw_scope_meta[sw_scope.to_s] || {}).delete(:pending_body))
          pending
        elsif !sw_script
          fetch_worker_script(target, parent_worker ? @workers.dig(parent_worker, :url) : frame_realm_url(realm_id),
                              opaque: creator_key.to_s.start_with?('opaque:'))
        end
        # Resource Timing for a DEDICATED worker's own main-script fetch — a browser files it in the
        # creating context's timeline (a classic worker as 'other', a module worker as 'script'; the
        # JS Worker constructor knows the type and reads this back after the spawn returns, filing it
        # in its own realm). A SHARED worker's script is NOT a subresource of any one document, so it
        # generates no entry (resource-timing/shared-worker-rt-entry); nor does a service worker's
        # registration. Only for a script actually fetched over the network here: a blob:/data: script
        # has no fetch to time, and an SW-intercepted worker script (`sw_script`, deferred) is timed
        # by the SW path. `csim_asset_meta` is the fetch fact `fetch_worker_script`'s `rack_fetch_body`
        # just stashed (cleared at the top of the spawn so a failed one can't leak).
        if !service && !shared && !sw_script && body && target.match?(%r{\Ahttps?://}i)
          Thread.current[:csim_worker_rt] = {'url' => target, 'meta' => Thread.current[:csim_asset_meta]}
        end
        # A dedicated or shared worker's global scope is at the URL its script came from at last — its same-origin redirects
        # followed (HTML "run a worker": the worker global scope's url is the response's), which its location, its imports'
        # base and its requests' referrer read. (A service worker's script may not redirect.)
        if !service && !sw_script && body && target.match?(%r{\Ahttps?://}i) && Thread.current[:csim_asset_url].to_s.match?(%r{\Ahttps?://}i)
          target = Thread.current[:csim_asset_url].to_s
        end
        # A blob: worker script that didn't resolve (revoked / unavailable) fails the
        # same way — fire onerror rather than spawn a worker that runs nothing.
        return worker_fail(handle, 'Worker script could not be loaded') if target.start_with?('blob:') && body.to_s.empty?
        # Pending until the worker's initial script has run (see @worker_initializing).
        @worker_init_lock.synchronize { @worker_initializing += 1 }
        # Register the worker's record BEFORE its thread exists: the sw_hooks fire from the
        # worker thread as early as the script EVAL (a top-level skipWaiting(), the extended
        # counter) and write through `@workers[handle]` — created after Thread.new, a fast
        # worker could look itself up before the registry insert and silently drop the write.
        # `service:` marks a SERVICE worker.
        # `realm:` is the browsing context that created this worker — a dedicated worker belongs to
        # it and is terminated when it is discarded (terminate_realm_workers).
        # `sw_scope`: a SERVICE worker's registration scope — process_worker_unregister
        # (the worker's own registration.unregister()) resolves the scope from it.
        # `rt` / `rt_lock`: the worker's own runtime, published by its thread once built, so the
        # session boundary can stop the JS half without waiting for it (see `stop_worker_js`). The
        # lock is per worker rather than the shared counter mutex: the only two things that ever
        # contend for it are that stop and the worker's own dispose, and holding it across a native
        # call must not block anything else in the browser.
        # `url`: the worker's own URL — its script's, after redirects — which a nested worker's script fetch is judged against.
        record = {thread: nil, inbox: inbox, service: service, realm: parent_worker ? 0 : realm_id.to_i, parent_worker: parent_worker, sw_scope: service ? sw_scope.to_s : nil, url: target, creator_key: creator_key, rt: nil, rt_lock: Mutex.new}
        # The Update algorithm byte-checks a new fetch against the running version's
        # script (+ its recorded imports — sw_note_import fills that map as the worker
        # evaluates). SW scripts are small; only service workers pay the retention.
        record[:script_body] = body if service
        # (…a dedicated worker's site for cookies its owner document's, kept as it was made — HTML's worker settings —
        # which its fetches, on its own thread, are judged by; a nested worker's its parent's)
        unless service
          # (…an opaque origin's none: a sandboxed frame's)
          record[:site_for_cookies] =
            if creator_key.to_s.start_with?('opaque:')
              nil
            elsif parent_worker
              @workers.dig(parent_worker, :site_for_cookies)
            else
              site_for_cookies(realm_id)
            end
        end
        # …and the registry's worker, its script URL and TYPE what every realm's ServiceWorker of it reflects (an
        # update()/re-register from any realm parse-checks and respawns as its newest worker's type).
        Native.sw_worker_new(@sw_partition, handle, target, script_type.to_s.empty? ? 'classic' : script_type.to_s) if service
        @workers[handle] = record
        thread = Thread.new do
          Thread.current.report_on_exception = false
          run_worker(
            handle, target, body, inbox, outbox,
            # The record, not `@workers[handle]` looked up later: `terminate_realm_workers` and
            # `reset_workers` remove entries WITHOUT waiting for the thread, and building the
            # isolate takes long enough (a fresh context plus ~20 host-fn attaches) for a frame
            # discarded in that window to leave the lookup empty. A worker whose record it never
            # found could publish no runtime and would never see the stop flag.
            record:      record,
            name:        name,
            shared:      shared,
            service:     service,
            creator_key: creator_key,
            sw_scope:    sw_scope,
            controller:  ctrl,
            sw_script:   sw_script,
            # `new Worker(url, {type: 'module'})` — the observable module/classic split
            # (importScripts is classic-only) rides into the isolate as a flag.
            module_worker: script_type.to_s == 'module',
            # The creating context's client id — the worker MAIN-SCRIPT fetch's clientId
            # (the PARENT WORKER's own client id for a nested spawn).
            creator_client: parent_worker ? sw_worker_client_id(parent_worker) : sw_client_id(realm_id.to_i),
            # The registration's updateViaCache mode — its job's, which commits only once this
            # evaluation ran — a SERVICE worker's importScripts reads ('none' bypasses the HTTP cache).
            sw_uvc: service ? update_via_cache || sw_scope_update_via_cache(sw_scope) : nil,
            sw_imports_map: pending_imports,
            # The registration's CURRENT active version at spawn time — its script URL and handle, the new
            # worker's `self.registration.active` snapshot during its own install phase (registration-attribute's
            # newer worker) and what its navigation preload is keyed by. Resolved here, on the registry-owning
            # thread.
            sw_prev_active: service && (ah = sw_serving[sw_scope.to_s]) && @workers[ah] ? {url: @workers[ah][:script_url], handle: ah} : nil
          )
        end
        # A nested spawn runs THIS method on a worker thread, so other threads can observe
        # the record's one-statement `thread: nil` window — every `[:thread]` reader
        # nil-guards and treats nil as "still spawning".
        record[:thread] = thread
        # A dedicated / shared worker is a client of its ORIGIN — type 'worker' / 'sharedworker',
        # frameType 'none' — whether or not a service worker's scope covers its script; only the
        # `controlled` flag turns on that scope match, exactly as it does for a browsing context.
        # A service worker is not itself a client of anything.
        unless service
          sw_note_worker_client(handle, target, shared, ctrl)
        end
        handle
      end

      # Fail a worker that can't be created (blocked / unloadable script): queue an
      # error event so the JS Worker/SharedWorker fires `onerror`, spawn no thread,
      # and return the (still >0) handle so the JS registers the worker and the error
      # reaches it.
      private def worker_fail(handle, message)
        @worker_outbox << {handle: handle, kind: '__error', message: message}
        handle
      end

      def worker_post_to_worker(handle, data)
        w = @workers[handle.to_i]
        # A worker whose thread died (script blocked / load raise → __error → onerror) keeps
        # its registry entry until an explicit terminate; a post to it must be a NO-OP (as in
        # real browsers) — counting it would strand @worker_in_flight forever.
        return unless w && w[:thread]&.alive?
        # Counted globally (what settle reads) AND per worker, so a worker that dies still owing
        # replies can hand back exactly what it holds. A LISTEN-ONLY worker never answers at all,
        # so without the per-worker tally its share is only released by the reset that fires when
        # the LAST worker goes — which never happens while a service worker is registered.
        @worker_in_flight += 1
        w[:in_flight] = w[:in_flight].to_i + 1
        w[:inbox] << data.to_s
      end

      # `ServiceWorker.postMessage` from a client window → deliver to the SW's `message` event with
      # `source` = the posting client. Tracked in @sw_message_pending (released by the worker's
      # `swack`) so settle waits for the SW to process it and any client.postMessage reply.
      def service_worker_post_message(handle, data, client_id = nil, client_url = nil)
        w = @workers[handle.to_i]
        return unless w
        @sw_message_pending += 1
        # A message the worker hasn't finished dispatching is a PENDING functional
        # event — it must hold a successor's activation exactly like an unsettled
        # waitUntil (sw_worker_extended?): the client posts 'wait' and calls update()
        # in the same turn, so the gate can run before the worker even popped it.
        # Locked: the worker thread decrements (run_worker's dispatch ensure), and an
        # unsynchronized read-modify-write can lose an increment — the gate would then
        # read 0 with a message still queued and activate prematurely.
        @worker_init_lock.synchronize { w[:sw_msgs] = w[:sw_msgs].to_i + 1 }
        w[:inbox] << {kind: 'sw_message', data: data.to_s, client: client_id, url: client_url}
      end

      # Does this worker have PENDING WORK that extends its lifetime — an unsettled
      # ExtendableMessageEvent.waitUntil (the `extended` hook) or a message it hasn't
      # finished dispatching? Holds an installed successor's activation EVEN past
      # skipWaiting (activation.https "skipWaiting bypasses no controllee requirement" —
      # it bypasses only the controllee half).
      def sw_worker_extended?(handle)
        w = @workers[handle.to_i]
        return false unless w

        !!w[:extended] || w[:sw_msgs].to_i.positive?
      end

      # HTML "try activate", decided in ONE host call (the client-side gate used to make three
      # reads — extended?, the realm-local skipWaiting flag, controls? — and the splits raced:
      # a skipWaiting delivered before the realm built its worker objects was lost outright).
      # The OUTGOING worker's pending extended work holds activation even PAST skipWaiting
      # (activation.https "skipWaiting bypasses no controllee requirement" — it bypasses only
      # the controllee half); skipWaiting is read off the CANDIDATE's worker record, where the
      # worker's own thread set it at post time.
      private def sw_may_activate?(outgoing_handle, candidate_handle)
        return false if sw_worker_extended?(outgoing_handle)
        return true if @workers.dig(candidate_handle.to_i, :skip_waiting)

        !sw_worker_controls_clients?(outgoing_handle)
      end

      # A controlled client's fetch → the controlling SW's `fetch` event. Tracked in
      # @sw_fetch_pending (released by the `fetch_response`) so settle waits for the SW's
      # respondWith. If the handle is dead, return false so the client falls back to the network.
      # A controlled worker's MAIN SCRIPT, served through its controlling SW's fetch event —
      # called on the SPAWNING worker's own thread (run_worker), never the main thread: the
      # spawn happens inside a JS host callback (`new Worker()`), where a synchronous wait for
      # an async respondWith deadlocks (the documented worker-interception lesson); a worker
      # thread parking on a plain Queue is free. The reply bypasses the outbox→main-thread
      # route entirely (@sw_direct_replies, filled by sw_deliver_fetch_response), so delivery
      # needs no main-thread drain; sw_direct_fetch still counts the park in
      # @sw_fetch_pending so the main thread HOLDS THE VIRTUAL CLOCK over the round trip
      # (see its comment).
      # Returns {body:, url:, controller:} — see worker_main_script_fetch below.
      # One main-script fetch event dispatched to `sw_handle` — the raw wire hash, or nil
      # when the SW never answered within budget (treated as fall-through). Validation and
      # the redirect chain live in worker_main_script_fetch.
      private def sw_script_fetch_event(sw_handle, url, client_handle, shared:, creator_client:)
        req = JSON.generate(
          method:      'GET',
          url:         url.to_s,
          headers:     {},
          body_b64:    '',
          mode:        'same-origin',
          destination: shared ? 'sharedworker' : 'worker',
          credentials: 'same-origin',
          # The main-script request's CLIENT is the CREATING document (the page that called
          # `new Worker` — worker-interception "correct client Ids"); the worker's own id is
          # what the request will CREATE (the wire's resultingClientId, consumed for non-nav
          # dispatches too).
          clientId:    creator_client || sw_worker_client_id(client_handle),
          resultingClientId: sw_worker_client_id(client_handle)
        )
        sw_direct_fetch(sw_handle, req, client_handle)
      end

      # A controlled worker's MAIN SCRIPT fetch, following the redirect chain the way
      # Fetch does for a worker script request (mode 'same-origin', redirect 'follow').
      # Each hop is re-matched against the registrations and dispatched to that scope's
      # SW — an SW-provided redirect re-enters interception (HTTP-redirect fetch re-runs
      # main fetch; worker-interception-redirect Case #3) — EXCEPT once a hop fell back
      # to the network: from then on no SW sees the chain (Handle Fetch sets the
      # request's service-workers mode to 'none'; Cases #1/#2).
      #
      # Returns {body:, url:, controller:}:
      #   `url`        — the FINAL RESPONSE URL, which becomes the worker's self.location
      #                  and the base its importScripts()/fetch() resolve against (a SW
      #                  respondWith(fetch(elsewhere)) moves it — Case #3's subdir).
      #   `controller` — the SW that got the LAST fetch event; it controls the worker
      #                  even when the final URL left every scope (the spec's "final
      #                  service worker that got a fetch event"), or nil (all-network).
      # Returns nil when the final response is an HTTP error (the worker fails to load),
      # or :error when the load is BLOCKED (network-error respondWith, a response type
      # same-origin mode forbids, a cross-origin / non-http Location, a redirect loop) —
      # it must fail the worker start, never fall back to the network.
      def worker_main_script_fetch(sw_handle, url, client_handle, shared: false, creator_client: nil)
        current    = url.to_s
        sw         = sw_handle.to_i
        sw_allowed = true
        last_sw    = nil
        hops       = 0
        loop do
          # Attempts = redirects + 1, so exactly MAX_FETCH_REDIRECTS follows succeed
          # (the same accounting rack_fetch documents at its own loop).
          return :error if (hops += 1) > MAX_FETCH_REDIRECTS + 1
          sw = sw_controller_for_navigation(current) if hops > 1 && sw_allowed
          if sw_allowed && sw
            last_sw = sw
            r = sw_script_fetch_event(sw, current, client_handle, shared:, creator_client:)
            if r && !r['fallthrough']
              # Handle Fetch response validation for the script's 'same-origin'-mode request: a
              # network-error respondWith, or a response its type forbids, is a NETWORK ERROR — the
              # worker must FAIL TO START (worker-interception "cors/no-cors … fails worker start").
              return :error if r['networkError'] || !sw_response_allowed?(r, 'same-origin')
              status = r['status'].to_i
              if REDIRECT_STATUSES.include?(status) && (loc = redirect_location(status, r['headers'] || {}))
                current = resolve_against(loc, r['url'].to_s.empty? ? current : r['url'])
                return :error unless same_origin_script_hop?(current, url)
                next
              end
              # "Fetch a classic worker script" requires an OK status whoever produced the
              # response — an SW respondWith'ing its 404 page must fail the load (a clean
              # `error` event), not start a worker that evals HTML. A redirect status
              # WITHOUT a Location lands here too, and 3xx is not ok.
              return nil unless (200..299).cover?(status)
              return {
                body:       Base64.decode64(r['body_b64'].to_s),
                url:        r['url'].to_s.empty? ? current : r['url'],
                controller: last_sw
              }
            end
            # No respondWith (or no answer): fall back to the network for THIS hop.
          end
          res = rack_fetch('GET', current, '', {}, 'manual')
          return :error unless resource_loaded?(res)
          if (loc = res['redirect_loc'])
            # A redirect received FROM THE NETWORK: no SW intercepts it or any later hop.
            sw_allowed = false
            current    = loc
            return :error unless same_origin_script_hop?(current, url)
            next
          end
          # 'manual' wraps every 3xx as an opaqueredirect (status 0): one WITHOUT a
          # Location carries `redirect_status` but no `redirect_loc` — not ok, load fails
          # (never start a worker on the empty filtered body). Everything else needs the
          # same OK status the SW branch enforces.
          return nil if res['redirect_status'] || !(200..299).cover?(res['status'].to_i)
          return {body: res['body'].to_s, url: current, controller: last_sw}
        end
      end

      # A worker-script redirect hop must stay http(s) and same-origin (the request's
      # mode is 'same-origin'); anything else is a network error for the chain.
      private def same_origin_script_hop?(next_url, original_url)
        next_url.to_s.match?(%r{\Ahttps?://}i) && url_origin(next_url) == url_origin(original_url.to_s)
      end

      # A controlled worker's `importScripts(url)`, routed through its SW's fetch event —
      # same synchronous direct-reply shape as the main-script fetch (the CALLING worker's
      # thread parks; never the main thread). Returns nil to fall through to the network,
      # {'blocked' => true} when the respondWith is a network error / a type the request's
      # same-origin mode forbids (importScripts then throws NetworkError), or a
      # resp-shaped hash ({'status', 'headers', 'body'}) the JS MIME-check + eval path
      # consumes exactly like a network response.
      # A controlled document's external classic `<script src>` fetched through its
      # controller (destination 'script'), SYNCHRONOUSLY on the calling (main)
      # thread — the parser blocks on a classic script per HTML, and the navigation
      # path already proved a host-callback block is safe while the worker thread
      # answers (the direct-reply queue needs no main-thread drain; this is what the
      # OLD reverted attempt predated). Returns nil to load from the network
      # (fallthrough / dead worker), {'blocked' => true} for a networkError
      # respondWith, {'body' =>} for a served script. An OPAQUE respondWith still
      # EXECUTES (browsers run opaque classic scripts) — its bytes ride the private
      # render channel like the image path.
      def sw_script_subresource_fetch(handle, url, client_id, referrer, destination = 'script', mode = 'no-cors', credentials = 'include', binary: false, integrity: '')
        w = @workers[handle.to_i]
        return nil unless w && w[:thread]&.alive?
        # A worker still ACTIVATING can't be waited for here — this caller blocks the
        # main thread synchronously, and the activation may need main-thread JS to
        # settle (the same deadlock the async fetch path avoids by PARKING). Load
        # from the network instead, exactly what an uncontrolled load did before
        # interception existed; the async-parking treatment is the follow-up.
        return nil unless @worker_init_lock.synchronize { w[:sw_activated] }
        req = JSON.generate(
          method:      'GET',
          url:         url.to_s,
          headers:     {},
          body_b64:    '',
          # The element's `crossorigin` attribute decides these (HTML "fetch a
          # classic script" / "obtain a stylesheet"), as the engine maps it
          # (fetch_rules.rs `cors_request`): absent → no-cors+include,
          # anonymous → cors+same-origin, use-credentials → cors+include.
          mode:        mode.to_s,
          # The element's raw `integrity` attribute, verbatim: event.request.integrity
          # reflects it even when unparseable (parsing happens at verification time).
          integrity:   integrity.to_s,
          destination: destination.to_s,
          credentials: credentials.to_s,
          clientId:    client_id.to_s,
          # Policy-resolved like every other controlled fetch (the raw document URL
          # must not leak into event.request.referrer beyond what the default
          # policy allows for a cross-origin subresource).
          referrer:    compute_referrer(nil, referrer.to_s, url.to_s).to_s
        )
        r = sw_direct_fetch(handle.to_i, req, handle.to_i) or return nil
        return nil if r['fallthrough']
        return {'blocked' => true} if r['networkError']

        # HTML "fetch a classic script" / "obtain a stylesheet": a non-ok response
        # fails the load (error event, nothing executes) — EXCEPT an opaque one
        # satisfying a NO-CORS request, which reports status 0 and still
        # executes/applies (its real bytes ride the private render channel). An
        # opaque response to a cors-mode request (a module script, a crossorigin
        # classic script) is a NETWORK ERROR per Handle Fetch — the bytes must
        # never compile: the engine's (fetch_rules.rs `sw_subresource_usable`).
        # MIME enforcement is the consumer's, which the answer's content type
        # rides along for: a module script's applies (`module_content`), but a
        # stylesheet's is deliberately not applied to a worker's answer yet — the
        # network path enforces it (`stylesheetResponseAccepted`, css-utils.js),
        # but a `new Response(text)` respondWith (text/plain) serving a
        # stylesheet is load-bearing for green static-router subtests.
        type   = r['type'].to_s
        status = type == 'opaque' ? 0 : (r['status'] || 200).to_i
        return {'blocked' => true} unless sw_response_allowed?(r, mode)
        # (…a non-ok answer is still a response, whose status a Resource Timing entry reports)
        return {'blocked' => true, 'status' => status} unless Native.sw_subresource_usable(destination.to_s, mode.to_s, type, r['redirected'] == true, status)

        body_b64 = r['body_b64'].to_s
        body_b64 = r['render_b64'].to_s if body_b64.empty? && r['render_b64']
        bytes    = Base64.decode64(body_b64)
        # A binary consumer (a classic script / video / font / image bytes) takes the bytes as they are — the
        # utf8 text funnel would mangle non-UTF-8 byte sequences — with the status, the content type and the
        # headers its checks and its Resource Timing entry read.
        if binary
          headers = r['headers'] || {}
          return {'bytes' => bytes, 'type' => type, 'status' => status, 'contentType' => header_field(headers, 'content-type').to_s, 'headers' => headers}
        end
        {'body' => RuntimeShared.utf8_text(bytes), 'status' => status, 'contentType' => header_field(r['headers'] || {}, 'content-type').to_s}
      end

      def sw_import_script_fetch(sw_handle, url, client_handle)
        req = JSON.generate(
          method:      'GET',
          url:         url.to_s,
          headers:     {},
          body_b64:    '',
          mode:        'same-origin',
          destination: 'script',
          credentials: 'same-origin',
          # A SUBRESOURCE from the worker: the worker itself is the client.
          clientId:    sw_worker_client_id(client_handle)
        )
        r = sw_direct_fetch(sw_handle, req, client_handle) or return nil
        return nil if r['fallthrough']
        return {'blocked' => true} if r['networkError'] || !sw_response_allowed?(r, 'same-origin')

        {
          'status'  => (r['status'] || 200).to_i,
          'headers' => r['headers'] || {},
          'body'    => RuntimeShared.utf8_text(Base64.decode64(r['body_b64'].to_s))
        }
      end

      # One synchronous fetch through a service worker, awaited on the CALLING worker's
      # own thread via a direct-reply queue (@sw_direct_replies — sw_deliver_fetch_response
      # checks it before any outbox routing, so delivery needs no main-thread drain).
      # Returns the parsed wire hash, or nil when the SW never answered within budget.
      #
      # Counted in @sw_fetch_pending for the whole park: it IS a controlled fetch awaiting
      # a respondWith, so the main thread's clock hold (hold_for_sw_fetch) applies — the
      # virtual clock must not outrun this off-thread round trip, or a slow machine's
      # scheduling delay burns a test's virtual timeout while two worker threads trade
      # 50 ms poll slices (the CI-only worker-interception-redirect failures). Bump and
      # release are both here (the direct reply never rides the outbox, so the
      # deliver_worker_messages decrement can't double-count it), self-balancing under
      # `ensure`.
      private def sw_direct_fetch(sw_handle, req_json, client_handle)
        w = @workers[sw_handle.to_i] or return nil
        q   = Thread::Queue.new
        fid = nil
        @sw_direct_lock.synchronize do
          fid = (@sw_direct_seq += 1)
          @sw_direct_replies[[sw_handle.to_i, fid]] = q
        end
        @worker_init_lock.synchronize { @sw_fetch_pending += 1 }
        w[:inbox] << {kind: 'fetch', req: req_json, fetch_id: fid, realm_id: -client_handle.to_i}
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + WORKER_ROUND_TRIP_BUDGET
        resp = nil
        while resp.nil? && Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
          resp = pop_with_timeout(q, WORKER_POLL_INTERVAL)
        end
        resp && JSON.parse(resp)
      rescue JSON::ParserError
        nil
      ensure
        if fid
          @sw_direct_lock.synchronize { @sw_direct_replies.delete([sw_handle.to_i, fid]) }
          @worker_init_lock.synchronize { @sw_fetch_pending = [0, @sw_fetch_pending - 1].max }
        end
      end

      def service_worker_controller_fetch(handle, req_json, fetch_id, realm_id = 0)
        w = @workers[handle.to_i]
        return false unless w
        # Resolve BEFORE bumping the pending counter: a raise here must not strand @sw_fetch_pending
        # (settle would then block for the full round-trip budget with no fetch ever queued to answer).
        req = resolve_sw_fetch_referrer(req_json.to_s)
        msg = {kind: 'fetch', req:, fetch_id: fetch_id.to_i, realm_id: realm_id.to_i}
        # Handle Fetch: "If activeWorker's state is activating, wait for it to become
        # activated" — a controlled client's fetch against a worker whose activate
        # waitUntil hasn't settled PARKS on the record (fetch-waits-for-activate; a client
        # can be controlled that early via clients.claim()). NOT counted pending yet: the
        # clock hold a pending fetch engages would starve the client timers the activation
        # itself is waiting on. Flushed — with the count — by the activated marker
        # (flush_sw_deferred_fetches), or as a network fallthrough if the worker dies.
        # Under the lock: this runs on the calling client's thread (main for a page,
        # a worker thread for a controlled worker) and races the main thread's flush.
        deferred = @worker_init_lock.synchronize do
          next false if w[:sw_activated]

          (w[:sw_deferred_fetches] ||= []) << msg
          true
        end
        return true if deferred

        # A CONTROLLED WORKER's fetch reaches here on the WORKER's thread (host fns run on
        # their caller); the unsynchronized += would race the main thread's decrement.
        @worker_init_lock.synchronize { @sw_fetch_pending += 1 }
        # fetch ids are per-realm (so they collide across realms) — carry the ORIGINATING realm so
        # the response is delivered back to it, not the main realm (realm 0 = main/top window).
        w[:inbox] << msg
        true
      end

      # A controlled client cancelled a streaming respondWith body (`response.body.cancel()` or an
      # AbortController abort): route the cancel to the worker that owns this [realm, fetch] stream so
      # it cancels the reader it's draining — firing the SW source stream's `cancel()`. @sw_open_streams
      # maps the stream to its emitting worker; the worker's terminal frame still clears the counter.
      def sw_stream_cancel(fetch_id, realm_id)
        key = [realm_id.to_i, fetch_id.to_i]
        handle, = @sw_open_streams.find {|_h, streams| streams.key?(key) }
        return unless handle && (w = @workers[handle])
        w[:inbox] << {kind: 'fetch_cancel', fetch_id: fetch_id.to_i}
      end

      # Resolve a controlled fetch's referrer the way the network hop would (compute_referrer
      # applies the request's Referrer-Policy to its referrer source), so the SW's
      # `event.request.referrer` matches a real browser's. The client sends the referrer SOURCE
      # (`referrerSource`, its document URL for the `about:client` default); we replace it with the
      # policy-resolved value under `referrer` (nil / stripped → '', the no-referrer state). No
      # source (older payload / navigation request) → passed through untouched.
      private def resolve_sw_fetch_referrer(req_json)
        req = JSON.parse(req_json)
        return req_json unless req.is_a?(Hash) && req.key?('referrerSource')

        req['referrer'] = compute_referrer(req['referrerPolicy'], req.delete('referrerSource'), req['url']).to_s
        JSON.generate(req)
      rescue JSON::ParserError
        req_json
      end

      # A SW `fetch` event's respondWith result. A NAVIGATION fetch (negative id — see
      # service_worker_navigation_fetch) is awaited SYNCHRONOUSLY on a dedicated queue, off the
      # general outbox, so it never interleaves with the client-fetch / message reply protocol;
      # a client fetch (positive id) rides the outbox as before, tagged with the originating realm.
      # Run the NETWORK LEG of a race-network-and-fetch-handler route — called
      # by the worker (its own thread) just before dispatching the fetch event,
      # and the leg runs synchronously right here; the winner is decided later
      # by the modeled-delay comparison (see the @sw_raced_fetches note at its
      # initialization and sw_race_take_network_win). A ≥400/failed network
      # response records nothing — the handler's response wins by default
      # ("server faster, but not found" uses the handler's 200). For a
      # NAVIGATION (negative id) the pre-fetched leg rides the nav outbox to
      # the parked nav thread, which owns that decision. Direct-reply fids
      # (worker main-script fetches) are not raced.
      private def sw_race_network(handle, fetch_id, realm_id, url, method)
        fid = fetch_id.to_i
        return if fid >= SW_DIRECT_FID_BASE
        # Only GET/HEAD race: the leg re-issues the request WITHOUT the original
        # body/headers, so racing a POST would run its side effect twice — once
        # mutilated. (Chromium's race source is effectively GET-shaped too; a
        # non-GET race-matched request simply behaves as fetch-event.)
        m = method.to_s.empty? ? 'GET' : method.to_s.upcase
        return unless %w[GET HEAD].include?(m)
        # Run the network leg RIGHT HERE, on the worker's own thread, before the
        # fetch event dispatches (this hook fires at the top of
        # __csim_swDispatchFetch). Sequential-on-one-thread makes the race
        # scheduling-independent; simultaneity is restored at DECISION time: the
        # leg's cost is the server's MODELED delay (the wpt py shim virtualizes
        # `time.sleep` and surfaces the total as X-Csim-Server-Delay-Ms; a
        # response without the header modeled no delay), the handler's cost is
        # its real dispatch-to-respondWith span, and whichever is smaller wins
        # (sw_deliver_fetch_response / the fetch_stream hook / the parked nav
        # loop all apply the same comparison).
        r = begin
          rack_fetch(m, url.to_s, '', {}, 'follow')
        rescue StandardError
          nil
        end
        usable = r && r['status'].to_i < 400
        if fid.negative?
          # Navigation: the parked nav thread owns the decision — hand it the
          # pre-fetched leg (FIFO: this marker precedes the handler's resp).
          # t0 is stamped HERE, on the worker thread just before dispatch, the
          # same convention as the fid>0 entry — measuring from the nav
          # thread's pop would fold a queue-wakeup hop into the handler's span.
          @sw_nav_outbox << {
            fetch_id: fid,
            race_leg: {
              resp:      usable ? JSON.generate(sw_race_wire(r)) : nil,
              server_ms: sw_server_delay_ms(r),
              t0:        Process.clock_gettime(Process::CLOCK_MONOTONIC)
            }
          }
          return
        end
        # An unusable leg (error / ≥400) records nothing: the handler serves
        # alone, exactly the "not found" preference the tests assert.
        return unless usable
        key = [realm_id.to_i, fid]
        @sw_race_lock.synchronize do
          @sw_raced_fetches[key] = {
            resp:      JSON.generate(sw_race_wire(r)),
            server_ms: sw_server_delay_ms(r),
            t0:        Process.clock_gettime(Process::CLOCK_MONOTONIC)
          }
        end
        nil
      end

      # The MODELED delay of a rack response: the wpt py shim accumulates the
      # handler's virtualized `time.sleep` calls into X-Csim-Server-Delay-Ms
      # (script/wpt_py_handler.py). Absent header → 0, DELIBERATELY: an
      # in-process rack response with no modeled delay IS effectively instant,
      # so for a non-shim (app) server the race source resolves to the network
      # side whenever the handler takes any real time. That bias is the model,
      # not an accident — revisit only if an app depends on a warm handler
      # beating its own server.
      private def sw_server_delay_ms(r)
        return 0.0 unless r
        h = (r['headers'] || {}).find {|k, _| k.to_s.casecmp('x-csim-server-delay-ms').zero? }
        h ? h.last.to_f : 0.0
      end

      # The race decision at respondWith time: network wins iff the server's
      # modeled delay undercuts the handler's measured dispatch span (a
      # fallthrough handler always loses to a usable leg). Consumes the entry
      # (exactly-once). Returns the winning NETWORK wire JSON, or nil when the
      # handler's own response should stand.
      # KNOWN LIMIT (deliberate): the decision happens at HANDLER-outcome time,
      # so a respondWith promise that never settles strands a won network leg
      # until reset and the fetch hangs like a plain fetch-event route (real
      # Chromium resolves with the network response the moment it arrives).
      # Every vendored handler answers promptly and the nav path has a budget
      # backstop; build a delivery-on-timeout (with a late-respondWith
      # tombstone) only if a real consumer hits this.
      private def sw_race_take_network_win(realm_id, fetch_id, handler_resp: nil)
        entry = @sw_race_lock.synchronize { @sw_raced_fetches.delete([realm_id.to_i, fetch_id.to_i]) }
        return nil unless entry
        # Exact match — every fallthrough producer emits this literal
        # (workers.js + the dispatch-failure fallback below); a substring sniff
        # could false-positive on a response HEADER literally named
        # "fallthrough".
        return entry[:resp] if handler_resp == '{"fallthrough":true}'
        handler_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - entry[:t0]) * 1000.0
        entry[:server_ms] < handler_ms ? entry[:resp] : nil
      end

      # `fetch(…, {keepalive: true})`: the request is dispatched EAGERLY on a detached
      # host thread at fetch() time, so it survives the death of the realm that issued
      # it (the whole point — an unload/pagehide handler's beacon must reach the server
      # after its iframe is removed; the WPT keepalive family stashes a token the NEXT
      # page polls for). The issuing realm, if it stays alive, collects the result by
      # polling keepalive_take on its normal deferred tick. Threads are NOT killed on
      # per-visit rebuild — surviving navigation is the contract — only at session
      # reset (reset_workers), when the Rack app itself goes away. The Fetch keepalive
      # quota (64 KiB of in-flight request payload) is enforced at start: -1 = over
      # quota, the caller rejects with TypeError synchronously, like a browser.
      KEEPALIVE_QUOTA = 65_536

      def keepalive_start(method, url, body, headers, redirect, mode, credentials, referrer_policy, referrer, cache_mode, client_url, realm = nil)
        # (…its site for cookies worked out here, on the main thread its realm's URL is asked on, for the thread it runs on)
        cookie_cross = realm.to_i.positive? && container_cross_site?(realm, url.to_s)
        # The quota reserves the PAYLOAD size: a text body arrives as its UTF-8 String and
        # any other as its BINARY bytes, so either way that is the String's byte count.
        size = body.to_s.bytesize
        id   = nil
        # ONE critical section for reserve + spawn: a reset between them would
        # leave the spawned thread unregistered for the boundary drain.
        @keepalive_lock.synchronize do
          return -1 if @keepalive_inflight + size > KEEPALIVE_QUOTA

          @keepalive_inflight += size
          id = (@keepalive_seq += 1)
          @keepalive_results[id]        = :pending
          @keepalive_inflight_sizes[id] = size
          spawn_app_request_thread do
            r = nil
            begin
              r = begin
                rack_fetch(method.to_s, url.to_s, body.to_s, headers || {}, redirect.to_s.empty? ? 'follow' : redirect.to_s,
                           mode, credentials: credentials || 'same-origin', referrer_policy: referrer_policy,
                           referrer: referrer, cache_mode: cache_mode || 'default', client_url: client_url, cookie_cross_site: cookie_cross)
              rescue StandardError
                nil
              end
            ensure
              # Release + finalize under `ensure`: an escaping non-StandardError (or a
              # kill) must not strand the reservation for the session, nor leave a
              # live page's poll parked on :pending forever. The per-id size map makes
              # the release GENERATION-SAFE: a thread completing after reset_workers
              # cleared the maps finds no entry and subtracts nothing from the next
              # session's tally.
              @keepalive_lock.synchronize do
                if (sz = @keepalive_inflight_sizes.delete(id))
                  @keepalive_inflight = [0, @keepalive_inflight - sz].max
                end
                @keepalive_results[id] = r if @keepalive_results[id] == :pending
              end
            end
          end
        end
        id
      end

      # One-shot: {pending: true} while the thread runs; the response wire hash (or
      # nil = network error) once done, deleting the slot.
      def keepalive_take(id)
        @keepalive_lock.synchronize do
          r = @keepalive_results[id.to_i]
          return {'pending' => true} if r == :pending

          @keepalive_results.delete(id.to_i)
          r
        end
      end

      # Drop pre-fetched race-leg entries. Called on every per-visit VM rebuild
      # AND on session reset: fetch ids are PER-VM (the client's fetchSeq
      # restarts), so a surviving entry would poison a later fetch that reuses
      # its id — a dead test's network response replacing a new test's
      # same-numbered handler response.
      private def reset_sw_race_state
        @sw_race_lock.synchronize { @sw_raced_fetches.clear }
      end

      # rack_fetch's hash as the SW respondWith wire, which travels as JSON text: its
      # bytes become the wire's base64 fields (`rawFromWire` turns them back), and the
      # body is always there — rack_fetch omits `body_bytes` for pure-ASCII text, where
      # `body` IS the bytes. The shim's internal delay header must not leak to script
      # on a network win.
      private def sw_race_wire(r)
        bytes  = r['body_bytes'] || r['body'].to_s.b
        render = r['opaque_render']
        r = r.except('body_bytes', 'opaque_render').merge(
          'type'     => r['type'] || 'basic',
          'body_b64' => Base64.strict_encode64(bytes)
        )
        r['render_b64'] = Base64.strict_encode64(render) if render
        if r['headers'].is_a?(Hash) && (k = r['headers'].keys.find {|h| h.to_s.casecmp('x-csim-server-delay-ms').zero? })
          r['headers'] = r['headers'].reject {|h, _| h == k }
        end
        r
      end

      private def sw_deliver_fetch_response(handle, fetch_id, resp, outbox, realm_id = 0)
        # A RACED fetch resolves exactly once, HERE, at the handler's arrival
        # (respondWith or fallthrough): the pre-fetched network leg wins when the
        # server's modeled delay undercuts the handler's measured dispatch span
        # — its wire replaces the handler's. The entry is consumed either way,
        # so nothing lingers and a later fetch reusing this per-VM id is safe.
        if fetch_id.to_i.positive? && (win = sw_race_take_network_win(realm_id, fetch_id, handler_resp: resp))
          resp = win
        end
        # A DIRECT reply channel (a controlled worker's main-script fetch, parked on its own
        # thread — sw_direct_fetch): hand the reply straight to that queue, bypassing
        # the outbox→main-thread drain the parked thread can't participate in.
        if (dq = @sw_direct_lock.synchronize { @sw_direct_replies.delete([handle.to_i, fetch_id.to_i]) })
          dq << resp
          return
        end
        # A direct-range fid whose waiter already timed out (its queue is gone from the
        # map): DROP it — outboxing would decrement @sw_fetch_pending for a fetch that
        # never incremented it, eating another fetch's settle barrier.
        return if fetch_id.to_i >= SW_DIRECT_FID_BASE
        if fetch_id.negative?
          @sw_nav_outbox << {fetch_id: fetch_id, resp: resp}
        else
          outbox << {handle: handle, kind: 'fetch_response', fetch_id: fetch_id, resp: resp, realm_id: realm_id}
        end
      end

      # The active worker handle at an EXACT scope (0 if none) — see __csim_swActiveHandleForScope.
      def sw_active_handle_for_scope(scope) = sw_serving[scope.to_s].to_i

      # The registrations the session's map holds (sw_registry.rs), `[scope, registered, activating, serving, id]` in the
      # order made — and the worker serving and the one activating each scope that has one.
      private def sw_regs = Native.sw_registrations(@sw_partition)
      private def sw_serving = sw_regs.each_with_object({}) {|(scope, _, _, serving), out| out[scope] = serving if serving }
      private def sw_activatings = sw_regs.each_with_object({}) {|(scope, _, activating), out| out[scope] = activating if activating }

      # Whether a service worker's response `r` (its wire form) may answer a request in `mode` with `redirect` (Fetch
      # "HTTP fetch" step 5.5 — the engine's).
      private def sw_response_allowed?(r, mode, redirect = 'follow')
        Native.service_worker_response_allowed(mode.to_s, redirect, (r['type'] || 'default').to_s, r['redirected'] == true)
      end

      # The registration map as a client of `origin` reads it — `[id, scope]` of each registration, in the order made —
      # the registration `url` matches there (its longest scope covering it), `[id, scope]` or nil, and the number of the
      # one the map holds at `scope` (0 for none).
      def sw_registrations_of(origin) = Native.sw_registrations_of_origin(@sw_partition, origin.to_s)
      def sw_match_registration(origin, url) = Native.sw_match_registration(@sw_partition, origin.to_s, url.to_s)
      def sw_registered_at(scope) = Native.sw_registered_at(@sw_partition, scope.to_s)

      # The registration `id`'s versions, `[installing, waiting, active]` (each a worker's handle, nil for none) — and
      # setting one (`slot`: 'installing', 'waiting' or 'active').
      def sw_versions(id) = Native.sw_versions(@sw_partition, id.to_i).to_a

      private def sw_set_version(id, slot, handle)
        Native.sw_set_version(@sw_partition, id.to_i, slot.to_s, handle&.to_i&.nonzero?)
        nil
      end

      # The service worker `handle`, `[script URL, type, state, registration]` (the registration's number, 0 before one
      # holds it), nil for none.
      def sw_worker(handle) = Native.sw_worker(@sw_partition, handle.to_i)&.to_a

      # Update Worker State: the worker `handle` in `state`, which every realm's ServiceWorker of it takes, its
      # `statechange` fired (and, activated, a client it now controls has its `ready`).
      private def sw_update_worker_state(handle, state)
        @sw_step_waits.delete(handle.to_i) if state.to_s == 'redundant'
        broadcast_to_realms('__csim_swWorkerStateChanged', handle.to_i, state.to_s) if Native.sw_set_worker_state(@sw_partition, handle.to_i, state.to_s)
        # (…a job waiting for this worker's install runs once it is installed, or failed)
        if state.to_s != 'installing' && (id = @sw_jobs_behind.delete(handle.to_i))
          sw_queue_job(id)
        end
        nil
      end

      # ── The Register and Update jobs (Service Workers §8) ──
      # A client's register() and a registration's update() schedule a job at its scope; the jobs
      # there run one at a time, in order (the scope's job queue), each as a task of the platform's on
      # the window's event loop (sw-client.js __csim_swQueueJob, which calls sw_run_job back), and
      # settle the promises waiting on it in every realm (__csim_swJobSettled).

      # A client's register() (`kind` 'register': its script URL and scope — nil: the script's directory — against the
      # client's `base` and `origin`, Start Register's checks first), a registration's update() or unregister() ('update' /
      # 'unregister': its number and scope), scheduled: `['job', its number]` — an equivalent register() joins the one
      # before it — or `[error name, message]`.
      # Service Workers are modeled only in a universal-server context (the WPT runner, where every host is served
      # in-process): a real app keeps the "not supported" rejection, so its registration-failed branch runs rather than
      # a half-modeled success path.
      def sw_schedule_job(kind, script_url, scope, update_via_cache, script_type, registration_id, base, origin, realm_id, creator_key)
        return ['SecurityError', 'Service Workers not supported'] unless all_hosts_local?

        if kind == 'register'
          ok, script_url, scope = Native.service_worker_start_register(script_url.to_s, scope&.to_s, base.to_s, origin.to_s)
          return [ok, script_url] unless ok == 'ok'
        end
        id, runs = Native.sw_schedule_job(
          @sw_partition,
          kind.to_s,
          scope.to_s,
          script_url.to_s,
          update_via_cache&.to_s,
          script_type.to_s,
          registration_id.to_i,
          realm_id.to_i,
          creator_key.to_s
        )
        sw_queue_job(id) if runs
        ['job', id]
      end

      # The job `id` queued to run, where it is not already.
      private def sw_queue_job(id)
        @runtime.call('__csim_swQueueJob', id) if @sw_jobs_queued.add?(id)
      end

      # …and run. A Register job at a scope whose newest worker already runs ITS script, under the same type, finishes at
      # once when the updateViaCache mode is unchanged too (register() resolves with the same registration, its workers
      # untouched — multiple-register); a changed mode makes it an Update with that mode, whose cache decisions just
      # changed (registration-updateviacache's X-then-Y cases). Any other waits while a worker is still INSTALLING at
      # the registration (update-not-allowed "from client succeeds while installing"; register-wait-forever-in-install-
      # worker) — a WAITING one is a finished job, which may be the very skipWaiting() version that releases the queue
      # (skip-waiting.https) — then fetches and byte-checks the script (sw_registration_update_fetch: a redirect, a
      # non-JS MIME type or a scope past the script's max scope rejects), and runs a changed one: the client announced
      # first (a worker may enumerate its clients while its script evaluates), its worker spawned, the job settled by
      # how that evaluation ends (sw_job_evaluated).
      def sw_run_job(id)
        id = id.to_i
        @sw_jobs_queued.delete(id)
        kind, scope, script_url, update_via_cache, script_type, registration, realm, creator_key = Native.sw_job(@sw_partition, id)
        return unless kind

        # The Unregister job: the registration the map holds at the scope out of it — its clear parked until no client
        # is using it — whether there was one.
        return sw_settle_job(id, unregistered: sw_unregister(scope)) if kind == 'unregister'

        verb = kind
        if kind == 'update'
          unless sw_mapped_scope(registration) == scope
            return sw_settle_job(id, 'TypeError', 'Failed to update a ServiceWorker: the registration has been unregistered.')
          end
        else
          registration = sw_registered_at(scope)
        end
        installing, waiting, active = sw_versions(registration)
        newest = installing || waiting || active
        newest_url, newest_type, = sw_worker(newest) if newest
        if kind == 'register' && newest && newest_url == script_url && newest_type == script_type
          return sw_settle_job(id, registration: registration) if (sw_scope_update_via_cache(scope) || 'imports') == update_via_cache

          kind = 'update'
        end
        if installing && sw_worker(installing)&.dig(2) == 'installing'
          @sw_jobs_behind[installing] = id
          return
        end
        if kind == 'update'
          return sw_settle_job(id, 'TypeError', 'Failed to update a ServiceWorker: no service worker.') unless newest

          script_url, script_type = newest_url, newest_type
        end
        fetched = sw_registration_update_fetch(scope, script_url, kind == 'update' ? newest : 0, update_via_cache)
        case fetched['error']
        when 'mime'  then return sw_settle_job(id, 'SecurityError', "Failed to #{verb} a ServiceWorker: the script has an unsupported MIME type.")
        when 'scope' then return sw_settle_job(id, 'SecurityError', "Failed to #{verb} a ServiceWorker: the scope is outside the script's max scope.")
        when String  then return sw_settle_job(id, 'TypeError', "Failed to #{verb} a ServiceWorker: the script fetch failed.")
        end
        unless fetched['changed']
          sw_set_update_via_cache(scope, update_via_cache) if update_via_cache
          return sw_settle_job(id, registration: registration)
        end

        realm = realm.to_i
        realm.zero? ? @runtime.call('__csim_swReportClient') : (@runtime.realm_call(realm, '__csim_swReportClient') if @runtime.frame_realm_alive?(realm))
        handle = worker_spawn(script_url, service: true, creator_key: creator_key, sw_scope: scope, script_type: script_type, update_via_cache: update_via_cache).to_i
        return sw_settle_job(id, 'TypeError', "Failed to #{verb} a ServiceWorker: the worker could not be started.") unless handle.positive?

        @sw_job_evals[handle] = id
        nil
      end

      # The job's worker `handle` evaluated its script ("Run Service Worker" gates the job): one whose evaluation failed
      # (an importScripts that 404s, a top-level throw, a script that does not parse) rejects the job's promises with no
      # version ever visible and the registration's mode untouched (registration-updateviacache "not updated if register()
      # rejects"); one that ran is the registration's installing worker — a Register job's registration made now, as the
      # map holds it NOW (another job may have made it meanwhile), the job's mode committed — and resolves them.
      private def sw_job_evaluated(handle, ok, message)
        id = @sw_job_evals.delete(handle) or return
        kind, scope, _script_url, update_via_cache, _script_type, registration = Native.sw_job(@sw_partition, id)
        return unless kind

        unless ok
          worker_terminate(handle)
          return sw_settle_job(id, 'TypeError', "Failed to #{kind} a ServiceWorker: the script evaluation failed. #{message}")
        end
        registration = sw_note_registered(scope) if kind == 'register'
        sw_set_update_via_cache(scope, update_via_cache) if update_via_cache
        sw_install(registration, handle)
        sw_settle_job(id, registration: registration)
      end

      # The job `id` finished — the next job at its scope queued to run — and settled: every realm's promises waiting on
      # it rejected with `error_name` (`message`) or resolved — a Register or Update job's with its realm's object of the
      # registration `registration`, an Unregister job's with whether it `unregistered` one, and a service worker's own
      # unregister() answered in its inbox. Finished FIRST: each realm runs its microtasks after the broadcast, and a
      # page's next register() there must find this job gone from the queue, not join it.
      private def sw_settle_job(id, error_name = nil, message = nil, registration: 0, unregistered: false)
        job   = Native.sw_job(@sw_partition, id)
        scope = job&.dig(1)
        asked = job&.dig(6).to_i
        nxt = Native.sw_finish_job(@sw_partition, id)
        sw_queue_job(nxt) if nxt
        if asked.negative?
          # (…the reply may never be consumed: an uncontrolled registration's uninstall clears at once, terminating this
          # very worker — the promise dies with the isolate, like a real terminated worker's)
          (w = @workers[-asked]) && w[:inbox] << {kind: 'unregister_result', ok: unregistered}
          return
        end
        broadcast_to_realms('__csim_swJobSettled', id, registration.to_i, scope.to_s, error_name, message, unregistered)
        nil
      end

      # ── A version's lifecycle (Service Workers §8 Install, Try Activate, Activate) ──
      # The registry decides each step (sw_registry.rs `advance`); the host takes it — the
      # registration's versions moved BEFORE any `statechange` (each realm runs its microtasks after
      # each broadcast, so a listener finds the registration as the step leaves it) — and queues the
      # next as a task of the platform's on the window's event loop (sw-client.js
      # __csim_swQueueStep, which calls sw_step back), so an observer sees every state between. A step
      # waiting on the worker's own phase or on Try Activate resumes at once when that arrives
      # (sw_resume_step).

      # A Register or Update job's worker `handle` evaluated: the registration `id`'s installing worker
      # now — superseding one still installing there (an update supersedes a pending worker, NOT the
      # active one, and a WAITING worker keeps waiting until the newer one is installed:
      # skip-waiting.https) — its lifecycle begun.
      private def sw_install(id, handle)
        h = handle.to_i
        pending, _waiting, active = sw_versions(id)
        sw_set_version(id, 'installing', h)
        sw_retire(pending) if pending && pending != active && pending != h
        Native.sw_begin_lifecycle(@sw_partition, h)
        sw_update_worker_state(h, 'installing')
        sw_queue_step(h)
        nil
      end

      # The worker `handle`'s next step queued, where it is not already.
      private def sw_queue_step(handle)
        @runtime.call('__csim_swQueueStep', handle) if @sw_steps_queued.add?(handle)
      end

      # …the worker `handle`'s lifecycle resumed where it waits for `what` (see @sw_step_waits).
      private def sw_resume_step(handle, what)
        sw_step(handle) if @sw_step_waits[handle] == what
      end

      # …and taken: the task queued for it, or a wait resumed.
      def sw_step(handle)
        handle = handle.to_i
        @sw_steps_queued.delete(handle)
        worker = sw_worker(handle) or return
        id   = worker[3]
        step = Native.sw_advance(@sw_partition, handle, sw_may_activate_in?(id, handle))
        if %w[install activation try_activate].include?(step)
          @sw_step_waits[handle] = step
          return
        end

        @sw_step_waits.delete(handle)
        case step
        when 'updatefound'    then sw_update_found(id)
        when 'installed'      then sw_installed(id, handle)
        when 'install_failed' then sw_install_failed(id, handle)
        when 'activating'     then sw_activating(id, handle)
        when 'activated'      then sw_activated(id, handle)
        end
        sw_queue_step(handle) if %w[updatefound installed activating].include?(step)
      end

      # Try Activate's verdict for the worker `handle` of the registration `id`: no outgoing worker to displace, or one
      # that may be displaced (sw_may_activate?).
      private def sw_may_activate_in?(id, handle)
        outgoing = sw_versions(id)[2]
        !outgoing || outgoing == handle || sw_may_activate?(outgoing, handle)
      end

      # installing → installed: the waiting worker. A version already SITTING there is retired now — per Update State
      # "installed", the previous waiting worker goes redundant the moment a newer one reaches installed
      # (skip-waiting.https: url2 redundant once url3 installs).
      private def sw_installed(id, handle)
        installing, waiting, = sw_versions(id)
        sw_set_version(id, 'waiting', handle)
        sw_set_version(id, 'installing', nil) if installing == handle
        sw_retire(waiting) if waiting && waiting != handle
        sw_update_worker_state(handle, 'installed')
      end

      # …or its install failed (a rejected install `waitUntil` — Install "installFailed"): redundant without ever
      # occupying the waiting or active slot, and a registration left with no version at all leaves the map (a failed
      # install must not resurrect an unregistered scope — unregister-then-register-new-script — nor leave a phantom
      # registration a later getRegistration() would find).
      private def sw_install_failed(id, handle)
        sw_set_version(id, 'installing', nil) if sw_versions(id)[0] == handle
        sw_retire(handle)
        scope = sw_mapped_scope(id)
        sw_unregister(scope) if scope && sw_versions(id).none?
      end

      # installed → activating, once Try Activate allows it: the one it replaces retired first (Activate's order), then
      # the active worker — and the host told it EXISTS but is still activating (Handle Fetch parks functional events
      # against the scope until it is activated: fetch-waits-for-activate), where the map still holds it. Every client
      # using the registration takes it as its controller now (Activate: Notify Controller Change), its fetches parking
      # on it, not reaching the retired one.
      private def sw_activating(id, handle)
        _installing, waiting, outgoing = sw_versions(id)
        sw_retire(outgoing) if outgoing && outgoing != handle
        sw_set_version(id, 'active', handle)
        sw_set_version(id, 'waiting', nil) if waiting == handle
        sw_update_worker_state(handle, 'activating')
        scope = sw_mapped_scope(id)
        sw_note_activating(scope, handle) if scope
        if (w = @workers[handle])
          broadcast_to_realms('__csim_swRegistrationActivated', handle, w[:script_url].to_s, sw_interception_worthy?(w))
        end
      end

      # …→ activated, once its activation completed: the worker serving its scope — before the state flips, as
      # sw_register_scope also flushes a buffered clients.claim(), and a real browser applies the claim during the
      # activate handler (a synchronous `statechange` listener reading `navigator.serviceWorker.controller` must
      # already see it) — while it is still its registration's active worker and the map still holds that.
      private def sw_activated(id, handle)
        scope = sw_mapped_scope(id)
        sw_register_scope(scope, handle) if scope && sw_versions(id)[2] == handle
        sw_update_worker_state(handle, 'activated')
      end

      # A version retired: redundant, and its isolate terminated.
      private def sw_retire(handle)
        sw_update_worker_state(handle, 'redundant')
        worker_terminate(handle)
      end

      # The scope the map holds the registration `id` at, nil where it holds it no longer.
      private def sw_mapped_scope(id) = sw_regs.find {|*, rid| rid == id }&.first

      # A worker is installing the registration `id`: every realm's registration object of it fires `updatefound`.
      private def sw_update_found(id)
        broadcast_to_realms('__csim_swRegistrationUpdateFound', id.to_i)
        nil
      end

      # Does `handle` still control any client? HTML's "try activate" holds an installed worker in
      # the WAITING slot for exactly as long as the outgoing worker has controllees — that is what
      # makes `registration.waiting` non-null, which is how every "a new version is available"
      # banner detects an update.
      def sw_worker_controls_clients?(handle)
        h = handle.to_i
        return false if h.zero?
        # Try Activate's gate is "no service worker client is USING the registration" —
        # a client uses it when the registration is its MATCHED one (scope match on the
        # client URL), controlled or not: an unclaimed in-scope document still blocks
        # the handover. Matching by URL is also what makes the verdict DETERMINISTIC —
        # the per-client controller handle is re-reported by realms and can transiently
        # read stale (the activation.https flake), while the URL and the scope are not.
        scope   = sw_serving.key(h)
        clients = Native.sw_clients(@sw_partition)
        return clients.any? {|_id, _url, controller| controller == h } unless scope

        clients.any? {|_id, url, controller| controller == h || sw_scope_match(url)&.last == scope }
      end

      # A Register job made the registration at `scope` (its first worker evaluated): its number. Idempotent; undone by
      # sw_unregister.
      private def sw_note_registered(scope) = Native.sw_note_registered(@sw_partition, scope.to_s)

      # The lifecycle reached 'activating' for this registration: the active
      # worker EXISTS from here on (Handle Fetch can find it), but its activate handler's
      # waitUntil hasn't settled — functional events against the scope park until the
      # activated step makes it the worker serving the scope (sw_register_scope).
      private def sw_note_activating(scope, handle)
        Native.sw_note_activating(@sw_partition, scope.to_s, handle.to_i)
        nil
      end

      # A worker worth routing a request through: it has a fetch handler (or the
      # snapshot is still unknown), or Static Routing rules — which serve
      # network/cache sources with no fetch handler at all. The single predicate
      # behind every has_fetch interception gate.
      private def sw_interception_worthy?(w) = w[:has_fetch] != false || !!w[:has_router_rules]

      # The still-activating worker whose registration scope covers `url`, or nil. A worker
      # whose activated marker was already PROCESSED (record flag set, its registration's active
      # worker in the same drain) no longer defers; a dead one can't answer, so don't park on it.
      private def sw_activating_controller_for(url)
        u = url.to_s
        activating = sw_activatings
        scope = activating.keys.select {|s| u.start_with?(s) }.max_by(&:length) or return nil
        # Handle Fetch matches the registration FIRST (longest scope wins across ALL
        # registrations), and only waits when THAT registration's worker is activating —
        # a longer, already-ACTIVE scope covering this URL dispatches immediately.
        registered = sw_scope_match(u)
        return nil if registered && registered[1].length > scope.length

        handle = activating[scope]
        w = @workers[handle] or return nil
        return nil if w[:sw_activated] || !sw_interception_worthy?(w) || !w[:thread]&.alive?

        handle
      end

      # Release the subresource fetches Handle Fetch parked while `handle` was 'activating'
      # (or, for a worker that died without activating, fall them through to the network so
      # their clients' pending fetch entries settle). The pending counter is bumped only
      # here, at real dispatch — a parked fetch must not engage the main thread's clock
      # hold (hold_for_sw_fetch), whose wait would starve the very client timers the
      # activation is parked on.
      private def flush_sw_deferred_fetches(handle, record: nil, fallthrough: false)
        w = record || @workers[handle.to_i]
        list = @worker_init_lock.synchronize { w && w.delete(:sw_deferred_fetches) }
        return unless list

        alive = !fallthrough && w[:thread]&.alive?
        list.each do |m|
          @worker_init_lock.synchronize { @sw_fetch_pending += 1 }
          if alive
            w[:inbox] << m
          else
            sw_deliver_fetch_response(handle.to_i, m[:fetch_id], '{"fallthrough":true}', @worker_outbox, m[:realm_id])
          end
        end
      end

      # Re-run every frame navigation a realm parked on an activating registration
      # (bridge.entry.js keeps the frame elements; the retry rebuilds each frame through
      # the normal path, which re-consults the — now settled — registration state).
      private def retry_deferred_navigations
        return unless @sw_navs_deferred

        @sw_navs_deferred = false
        broadcast_to_realms('__csim_swRetryDeferredNavs')
      end

      private def sw_register_scope(scope, handle)
        # (…registered too: registered ⊇ activated — covers registration objects that reached activation without the
        # register()-time note, synthesized cross-realm ones)
        Native.sw_activated(@sw_partition, scope.to_s, handle.to_i)
        # Flush any clients.claim() that arrived before this worker was its scope's active one (a worker's
        # `activate → clients.claim()` fires decoupled from the lifecycle step that makes it the
        # registry's active worker, so the claim can be drained first — see the claim handler above).
        if @sw_pending_claims.any? {|e| e[:handle].to_i == handle.to_i }
          flush, @sw_pending_claims = @sw_pending_claims.partition {|e| e[:handle].to_i == handle.to_i }
          flush.each {|e| broadcast_claim(e[:handle], e[:has_fetch], scope.to_s) }
        end
        nil
      end


      # Call a host fn in EVERY live browsing context — the main realm and each frame/window realm.
      # Service-worker registration state is per-realm (each has its own registration objects), so
      # anything that changes it has to reach all of them.
      private def broadcast_to_realms(fn, *args)
        @runtime.call(fn, *args) rescue nil
        @runtime.frame_realm_ids.each do |rid|
          @runtime.realm_call(rid, fn, *args) if @runtime.frame_realm_alive?(rid)
        rescue StandardError
          nil
        end
        nil
      end

      # Deliver a clients.claim() to EVERY in-scope client: broadcast to the main realm AND every
      # frame realm; each self-checks whether its own document is in the claiming registration's
      # scope (__csim_swClaimClient) so no realm→URL map is needed here. has_fetch = the SW's
      # install-time fetch-listener snapshot, so a claimed client routes its fetches.
      private def broadcast_claim(handle, has_fetch, scope)
        # The claim's has_fetch snapshot predates install — a router-rules-only SW
        # (no fetch handler; addRoutes during install) must still make its claimed
        # clients route, so the worker-side router can serve its sources.
        has_fetch ||= !!@workers.dig(handle.to_i, :has_router_rules)
        script_url = @workers.dig(handle.to_i, :script_url).to_s
        # The claim IS the controller assignment: record it host-side for every client
        # whose MATCHED registration is this scope, so the activation gate
        # (sw_worker_controls_clients?) and matchAll never depend on the realm
        # re-report round trip that can race a load-time report (activation.https).
        # The claim's longest-registration-wins checks (host record below, realm-side
        # self-check via all_scopes) must see EVERY registration whose lifecycle has an
        # active worker — active in the registry OR still activating there.
        # Claims from activating workers broadcast immediately
        # now, so a LONGER registration that is itself mid-activation is a real
        # candidate; comparing against the active registrations alone lets a shorter scope's
        # claim transiently seize a client the longer one matches
        # (claim-not-using-registration under CI load).
        candidate_scopes = sw_regs.filter_map {|s, registered, activating, serving| s if registered || activating || serving } | [scope.to_s]
        Native.sw_clients(@sw_partition).each do |id, url, _controller|
          matched = candidate_scopes.select {|s| url.start_with?(s) }.max_by(&:length)
          # A claim from a still-ACTIVATING worker: it isn't its scope's active worker
          # yet, so the host record must be written here for exactly this path too, or
          # the controller falls back to the realm re-report race the record exists to
          # kill. The claim wins a client only when its scope is that client's longest
          # match among every candidate registration.
          Native.sw_set_client_controller(@sw_partition, id, handle.to_i) if matched == scope
        end
        all_scopes = candidate_scopes
        @runtime.call('__csim_swClaimClient', handle, has_fetch, script_url, scope, all_scopes)
        @runtime.frame_realm_ids.each do |rid|
          @runtime.realm_call(rid, '__csim_swClaimClient', handle, has_fetch, script_url, scope, all_scopes) if @runtime.frame_realm_alive?(rid)
        end
        # Worker CLIENTS too (a dedicated/shared worker whose script URL is in scope adopts
        # the claiming SW): same self-check, run in the worker's isolate via its inbox.
        # Snapshot: a live worker thread can insert into @workers (a nested spawn) mid-walk.
        @workers.to_a.each do |_h, w|
          next if w[:service] || !w[:thread]&.alive?

          w[:inbox] << {kind: 'claim_client', handle: handle, has_fetch: has_fetch, script_url: script_url, scope: scope, all_scopes: all_scopes}
        end
        nil
      end
      # Navigation Preload state of the registration at `scope`. Returns the spec default
      # {enabled:false, headerValue:'true'} when never set. Read by the client- and worker-side
      # NavigationPreloadManager (getState) and at navigation time (nav_preload_enabled?).
      def nav_preload_state(scope)
        enabled, header = Native.sw_navigation_preload(@sw_partition, scope.to_s)
        {'enabled' => enabled, 'headerValue' => header}
      end

      # Update the state of the registration at `scope`. A nil `enabled` / `header` leaves that field
      # unchanged (enable/disable set only enabled; setHeaderValue sets only the header — the JS side has
      # already validated the header value). The InvalidStateError "no active worker" gate lives in the
      # JS manager.
      def nav_preload_set(scope, enabled, header)
        Native.sw_set_navigation_preload(@sw_partition, scope.to_s, enabled.nil? ? nil : !!enabled, header&.to_s)
        nil
      end

      # Whether the registration at `scope` has navigation preload enabled — gates the parallel preload
      # request during a navigation.
      def nav_preload_enabled?(scope)
        scope ? Native.sw_navigation_preload(@sw_partition, scope.to_s).first : false
      end

      # The Unregister job at `scope` — a client's `registration.unregister()`, the service worker's own, or a Register
      # job whose only version failed to install: the registration out of the map (its mode and navigation preload
      # state with it: a registration made at the scope later is a new one), which every realm's registration object
      # of it sees at once. Its Clear Registration is parked (spec "Try Clear Registration"): the workers stay live —
      # an existing controllee keeps its controller and interception — until no client is USING the registration
      # (controller == its active worker) and none of its workers has pending extended work. The verdict is host
      # state, so the clear rides the same wakeup invariant as the activation gate: every hold-clearing transition
      # (client teardown, extended drain, message dispatch, worker reap) funnels through unregister_client / the
      # try_activate delivery point, and both re-run this check. Whether the map held one.
      private def sw_unregister(scope)
        id = Native.sw_unregister(@sw_partition, scope.to_s)
        @sw_scope_meta.delete(scope.to_s)
        @sw_pending_uninstalls << id if id
        try_clear_uninstalls
        # A navigation parked on this scope's activation must not wait forever for an
        # activated marker that now never comes — replay it against the network.
        retry_deferred_navigations
        !id.nil?
      end

      # A service worker's own `registration.unregister()` (rode the outbox as
      # 'sw_unregister'): an Unregister job at its scope, the promise parked in the worker
      # answered with the had-status when the job settles (sw_settle_job).
      private def process_worker_unregister(handle)
        w = @workers[handle]
        return unless w && w[:service]

        scope = w[:sw_scope].to_s
        scope = sw_serving.key(handle).to_s if scope.empty?
        return w[:inbox] << {kind: 'unregister_result', ok: false} if scope.empty?

        id, runs = Native.sw_schedule_job(@sw_partition, 'unregister', scope, '', nil, '', 0, -handle, '')
        sw_queue_job(id) if runs
        nil
      end

      # "No client is using the registration and no extended work is pending". A client
      # record still holding a DEAD active handle keeps the entry parked until that
      # client departs (records are only pruned on client teardown / the last-worker
      # reset) — bounded by the client's lifetime, and nothing outside try_clear itself
      # kills an uninstalling registration's worker today.
      private def sw_registration_clearable?(id)
        *, active = versions = sw_versions(id)
        return false if active && Native.sw_clients(@sw_partition).any? {|_id, _url, controller| controller == active }

        versions.compact.none? {|h| sw_worker_extended?(h) }
      end

      private def try_clear_uninstalls
        return if @sw_pending_uninstalls.empty?

        ready, @sw_pending_uninstalls = @sw_pending_uninstalls.partition {|id| sw_registration_clearable?(id) }
        ready.each do |id|
          # Clear Registration: the versions emptied, then each worker redundant in every realm — a `statechange`
          # listener already finds the registration empty, as in Chrome (each realm runs its microtasks after each
          # broadcast, so a later emptying would be seen half done) — then the isolates ended.
          handles = sw_versions(id).compact.uniq
          Native.sw_clear_registration(@sw_partition, id)
          handles.each {|h| sw_update_worker_state(h, 'redundant') }
          handles.each {|h| worker_terminate(h) }
        end
        nil
      end

      # ── Registration update (registration.update() / re-register with a changed
      # updateViaCache) ──

      # The registration's updateViaCache mode, or nil when the scope holds none (never
      # set, or unregistered — the CLIENT defaults to 'imports' and keeps its last echo
      # on a dead registration, so the host must not synthesize a default here).
      def sw_scope_update_via_cache(scope) = Native.sw_update_via_cache(@sw_partition, scope.to_s)

      # …committed by a job that succeeded (sw_run_job, sw_job_evaluated).
      private def sw_set_update_via_cache(scope, uvc)
        Native.sw_set_update_via_cache(@sw_partition, scope.to_s, uvc.to_s)
        nil
      end

      # A SERVICE worker's importScripts, recorded on its worker registry entry
      # (URL → bytes) so the Update algorithm can byte-check the imports when the main
      # script came back identical. Called from the WORKER's thread (host fns run on
      # their caller) — the same cross-thread registry-write pattern the SW hooks use.
      def sw_note_import(handle, url, body)
        # Copy-on-write: this can run on the WORKER's thread (a late importScripts /
        # module-graph fetch) while the main thread's Update probe iterates the map
        # (sw_registration_update_fetch) — an in-place insert there raises "can't add
        # a new key into hash during iteration".
        (w = @workers[handle.to_i]) && w[:sw_imports] = (w[:sw_imports] || {}).merge(url.to_s => body.to_s)
        nil
      end

      # The Update algorithm's fetch + byte-check ("Soft Update" core): re-fetch the MAIN
      # script — through the HTTP cache only in 'all' mode, else revalidating (no-cache) —
      # and, when it comes back byte-identical, each recorded IMPORTED script ('none'
      # bypasses the cache; 'imports'/'all' read it). ANY difference ⇒ a new version
      # installs; the fetched main bytes are parked for its spawn. Failure classes map to
      # update()'s rejections: 'redirect' (a SW script fetch must not redirect) and
      # 'network' are TypeErrors, 'mime' a SecurityError.
      # `uvc_override` carries a register() call's OWN mode before it is committed — a
      # failing register must leave the stored mode untouched ("updateViaCache is not
      # updated if register() rejects"), so the fetch reads the override, and the job
      # stores it only once its worker evaluated.
      private def sw_registration_update_fetch(scope, script_url, newest_handle, uvc_override = nil)
        uvc = uvc_override || sw_scope_update_via_cache(scope) || 'imports'
        # The MAIN script request carries `Service-Worker: script` (Update algorithm —
        # servers gate SW scripts on it); imported scripts must NOT (service-worker-header).
        res = rack_fetch('GET', script_url.to_s, '', {'Service-Worker' => 'script'}, 'manual', cache_mode: uvc == 'all' ? 'default' : 'no-cache')
        return {'error' => 'network'} unless resource_loaded?(res)
        return {'error' => 'redirect'} if res['redirect_loc'] || res['redirect_status']
        return {'error' => 'network'} unless (200..299).cover?(res['status'].to_i)
        ct = (res['headers'] || {}).find {|k, _| k.to_s.casecmp('content-type').zero? }&.last
        return {'error' => 'mime'} unless js_mime_type?(ct)
        # (…and the scope one the script may control: its directory, or the path its Service-Worker-Allowed names)
        # (…a header given more than once combined, as `response_hash` hands every one over)
        allowed = (res['headers'] || {}).find {|k, _| k.to_s.casecmp('service-worker-allowed').zero? }&.last
        case Native.service_worker_max_scope(scope.to_s, script_url.to_s, allowed)
        when 'network' then return {'error' => 'network'}
        when 'scope'   then return {'error' => 'scope'}
        end

        w       = @workers[newest_handle.to_i]
        body    = res['body'].to_s
        changed = w.nil? || body.b != w[:script_body].to_s.b
        probed  = {}
        unless changed
          import_mode = uvc == 'none' ? 'no-cache' : 'default'
          (w[:sw_imports] || {}).each do |u, b|
            r2 = rack_fetch('GET', u, '', {}, 'follow', cache_mode: import_mode)
            ok = resource_loaded?(r2) && (200..299).cover?(r2['status'].to_i)
            # The probe results ARE the new version's script resource map (Chrome
            # fetches each script ONCE during Update and the new worker runs from
            # those responses): a 404 seen here must be the 404 its importScripts
            # sees, not a lucky re-fetch (update-import-scripts "missing the other").
            # The body crosses into the isolate via JSON.generate — a rack body is
            # BINARY-tagged and a non-UTF-8 one would raise there, failing the update
            # a real browser runs with replacement characters.
            probed[u] = ok ? {'status' => r2['status'], 'headers' => r2['headers'], 'body' => RuntimeShared.utf8_text(r2['body'].to_s.dup)} : {'status' => 404, 'headers' => {}, 'body' => ''}
            nb = ok ? r2['body'].to_s : nil
            # A FAILING import re-fetch is "no change" for that import (update-import-
            # scripts "treat 404 on imported scripts as no change") — the update must
            # not install a broken version off a transient import failure.
            next if nb.nil? || nb.b == b.b

            changed = true
            break
          end
        end
        if changed
          meta = (@sw_scope_meta[scope.to_s] ||= {})
          meta[:pending_body]    = body
          meta[:pending_imports] = probed if probed.any?
        end
        {'changed' => changed}
      end

      # Whether a Content-Type is a JavaScript MIME type's ("fetch a classic worker script" requires one; a service worker
      # script with any other fails with a SecurityError) — the engine's (script.rs), the type extracted as Fetch does.
      private def js_mime_type?(content_type)
        Native.javascript_content(content_type.to_s)
      end

      # The registration handle controlling `url` — the one whose serialized scope is the longest
      # prefix of `url` (spec "Match Service Worker Registration"; the scope embeds the origin, so
      # a cross-origin scope can't prefix-match). nil when no registration's scope matches.
      #
      # …a registration whose worker has ACTIVATED counts from its activated marker on, before the
      # lifecycle step that makes it the worker serving its scope (`sw_register_scope`) has
      # run: from the marker on a navigation no longer waits for it (`sw_activating_controller_for`),
      # and matched against the active workers alone, one landing in between went to the network uncontrolled.
      # With `activating:`, one whose worker is still ACTIVATING counts too — what a client's CONTROLLER
      # is (Handle Fetch sets a reserved client's active service worker to the registration's active
      # worker before it asks whether that worker handles fetches at all, let alone waits for it).
      private def sw_scope_match(url, activating: false)
        u = url.to_s
        # (…a worker that died activating is none: until its reap is drained it would win the tie below and leave the
        # match with no live controller, where the outgoing active worker is still there to fall back to)
        activated = sw_activatings.select do |_scope, handle|
          (w = @workers[handle]) && w[:thread]&.alive? && (activating || @worker_init_lock.synchronize { w[:sw_activated] })
        end
        best = nil
        best_len = -1
        sw_serving.each do |scope, handle|
          next unless u.start_with?(scope) && scope.length > best_len

          best     = [handle, scope]
          best_len = scope.length
        end
        # (…and one activating at the SAME scope as an active one is an update: Activate has made the new worker the
        # registration's active worker, so it wins the tie over the outgoing one)
        activated.each do |scope, handle|
          next unless u.start_with?(scope) && scope.length >= best_len

          best     = [handle, scope]
          best_len = scope.length
        end
        best
      end

      # The controller for a freshly-built frame realm at `url`, for wiring its
      # `navigator.serviceWorker.controller`. Returns [handle, has_fetch, script_url] or nil.
      # Unlike the navigation variant this keeps a controller whose fetch-handler snapshot is
      # still UNKNOWN (nil, racing the SW's initial eval) — resolved to `true` here so the frame
      # is controlled and routes; a controlled subresource fetch simply falls through to the
      # network if no handler materializes. Only a KNOWN-false (messaging/push-only) SW skips.
      #
      # A registration whose worker is still ACTIVATING controls the frame too: a navigation into it waits for the
      # activation only where the worker handles fetches (`sw_activating_controller_for`), and one that does not —
      # a worker with no fetch handler — was built at once, matched against the active registrations alone, and left
      # uncontrolled (WPT unregister-then-register "does not resurrect the registration", 2 runs in 10).
      def sw_client_controller_for(url)
        match = sw_scope_match(url, activating: true) or return nil
        handle, scope = match
        w = @workers[handle] or return nil
        return nil unless w[:thread]&.alive?

        # Static Routing rules make a fetch-handler-less SW interception-worthy: the
        # client must route so the worker-side router can serve network/cache sources.
        [handle, sw_interception_worthy?(w), w[:script_url].to_s, scope]
      end

      # The handle of the service worker controlling a newly spawned worker, or nil.
      #
      # A worker with a REAL script URL is matched against registration scopes like any other
      # client, whatever its creator is doing: clients-matchall-client-types creates its dedicated
      # worker from the (out-of-scope, uncontrolled) top-level page and still expects a plain
      # `matchAll({type: 'worker'})` to return it.
      #
      # A blob: / data: script URL is OPAQUE — a UUID no scope could ever cover — so such a worker
      # takes its creator's controller instead (clients-matchall-blob-url-worker: controlled when
      # an in-scope frame creates it, uncontrolled when an out-of-scope page does). That has to be
      # the creating realm's LIVE controller, handed over at `new Worker(…)` time: control usually
      # arrives after load via `clients.claim()`, so a controller snapshotted when the realm was
      # BUILT is stale by then, and would report such a worker uncontrolled.
      private def worker_controller_handle(url, shared, creator_controller)
        return sw_client_controller_for(url)&.first if url.to_s.match?(%r{\Ahttps?://}i)
        # A SHARED worker has no single creating context to inherit from.
        return nil if shared

        h = creator_controller.to_i
        h.zero? || !@workers[h] ? nil : h
      end

      # Terminate every dedicated / shared worker a discarded browsing context created. A worker
      # is owned by its creating context: when that context goes away the worker is terminated,
      # so it must stop being a service-worker client too (worker_terminate unregisters it).
      # Without this a frame's worker outlives its frame — a leaked thread AND a leaked client.
      def terminate_realm_workers(realm_id)
        rid = realm_id.to_i
        return nil if rid.zero?

        discard_workers(@workers.to_a.select {|_h, w| w[:realm] == rid && !w[:service] }.to_h)
      end

      # …and every one the window's document — and its frames, and their workers — created, as a navigation replaces
      # it (HTML: a worker's owner set emptied). Only a service worker outlives its clients.
      private def terminate_document_workers
        discard_workers(@workers.to_a.reject {|_h, w| w[:service] }.to_h)
      end

      # (…`doomed` and — transitively — their NESTED workers, recorded with realm 0 + parent_worker: their Worker
      # objects live in the dying parents' isolates, so no one can reach them once those go. A snapshot, as a live
      # worker thread can insert into @workers (a nested spawn) mid-walk.)
      private def discard_workers(doomed)
        loop do
          more = @workers.to_a.select {|h, w| w[:parent_worker] && doomed.key?(w[:parent_worker]) && !doomed.key?(h) }
          break if more.empty?

          more.each {|h, w| doomed[h] = w }
        end
        doomed.each do |handle, w|
          # Everything `worker_terminate` does EXCEPT waiting for the thread. That wait is two
          # blocking joins with a `Thread#kill` between them, and this runs on the frame-disposal
          # path — which a frame-heavy app takes on every navigation, so a join here is a
          # per-navigation stall on the main thread (rule 3). Asking the worker to stop is enough:
          # it breaks its own poll loop and the thread exits on its own.
          # The reap must still happen, and happen HERE: it releases the reply-pending counters the
          # worker still holds and resets them once the last worker is gone, without which
          # `polling?` stays true for the rest of the session.
          @workers.delete(handle)
          detach_worker(handle, w)
          # …and stop the JS half, which `detach_worker`'s inbox message cannot: a worker inside a
          # call reads no messages. This does NOT block — a mutex and one `terminate` — so it does
          # not reintroduce the per-navigation stall the joins were removed to avoid.
          stop_worker_js(w)
          # Racing the still-live thread is benign: a fallback reply it also answers is dropped
          # (the client's pending-fetch entry is one-shot), and the only real cost is that a blob
          # URL minted in the moment between the revoke and the thread noticing `:terminate` can
          # leak — far cheaper than stalling every navigation.
          reap_worker(handle, w)
        end
        nil
      end

      # The controller an OPAQUE child browsing context (about:blank / srcdoc)
      # inherits from its creator. An about:blank document has no URL to scope-match,
      # so it's controlled by its parent's active service worker (HTML "create and
      # initialize a Document" inherits the creator's controller) — the one the parent
      # has NOW, in the client registry, which a claim since its load updated too.
      def sw_inherited_controller_for(parent_realm_id)
        parent = sw_client_id(parent_realm_id)
        _id, _url, handle = Native.sw_clients(@sw_partition).find {|id, *| id == parent }
        return nil unless handle
        w = @workers[handle]
        return nil unless w&.dig(:thread)&.alive?

        [handle, sw_interception_worthy?(w), w[:script_url].to_s, sw_serving.key(handle).to_s]
      end

      # A browsing context as a service-worker client, in the registry every service worker's
      # Clients read. `controller_handle` is the worker that CONTROLS it, or nil for an
      # uncontrolled context — a client belongs to its ORIGIN, not to one registration, so
      # `matchAll({includeUncontrolled: true})` sees it either way. Reported by the realm itself
      # (js/src/sw-client.js) at document load and whenever control is installed, because only the
      # realm knows its own URL and frame type. The client id is realm-scoped and stable for the
      # realm's life.
      def sw_note_client(realm_id, url, frame_type, controller_handle = nil, origin = nil)
        note_client(sw_client_id(realm_id), url, 'window', frame_type, controller_handle, origin)
      end

      # A dedicated / shared WORKER that a service worker controls is a client too — with no
      # visibilityState or focus (those are WindowClient's), `frameType` 'none', and its script
      # URL. Keyed by worker handle, which outlives nothing else and is unique per worker.
      # (…its origin its script URL's — a blob: worker's its creator's, the blob URL entry's environment's: the creator's
      # origin key, which an opaque origin's is none a service worker sees)
      def sw_note_worker_client(handle, url, shared, controller_handle)
        origin =
          if url.to_s.start_with?('blob:')
            key = @workers[handle]&.dig(:creator_key).to_s
            key.start_with?('http:', 'https:') ? key : nil
          else
            url_origin(url)
          end
        note_client(sw_worker_client_id(handle), url, shared ? 'sharedworker' : 'worker', 'none', controller_handle, origin)
      end

      # A worker CLIENT's controller changed (a clients.claim() the worker isolate adopted): its
      # record's, the worker-shaped counterpart of a realm's reportAsClient. Called from the WORKER's
      # thread (host fn) — the registry is the engine's, behind its lock.
      def sw_note_worker_controller(worker_handle, controller_handle)
        Native.sw_set_client_controller(@sw_partition, sw_worker_client_id(worker_handle), controller_handle.to_i.nonzero?)
        nil
      end

      # (…`origin` the client's own — a window's its document's, which an about:blank one inherits — what a service worker
      # filters the clients it sees by)
      private def note_client(client_id, url, type, frame_type, controller_handle, origin)
        ctrl = controller_handle.to_i
        ctrl = nil if ctrl.zero?
        # Within one document a controller is only ever GAINED (a claim / register
        # install) — never detached. A SAME-URL re-report carrying none is therefore a
        # stale racer (a load-time report overtaking the claim's install — the
        # activation.https flake), not a real loss: keep the recorded controller while
        # its worker lives. A NAVIGATED report (different URL) resets as before.
        prev_url, prev_ctrl = Native.sw_client_entry(@sw_partition, client_id.to_s)
        if ctrl.nil? && prev_ctrl && prev_url == url.to_s && @workers.dig(prev_ctrl, :thread)&.alive?
          ctrl = prev_ctrl
        end
        Native.sw_note_client(@sw_partition, client_id.to_s, url.to_s, type.to_s, frame_type.to_s, origin&.to_s, ctrl)
        # (…and, a window's, the focused ids recomputed: its id is the one it adopted, which may be new)
        Native.sw_set_focused(@sw_partition, focused_client_ids) if type.to_s == 'window'
        nil
      end

      # Navigate a client's browsing context on behalf of `WindowClient.navigate()`, then answer the
      # worker waiting on it. The reply carries where the client ENDED UP:
      #   url   — the final URL, when the result is same-origin (the promise resolves with the client)
      #   ''    — the result is CROSS-ORIGIN, which the spec resolves with null rather than handing
      #           back a client this worker has no business seeing
      #   error — the navigation was refused (mixed content, or a context we can't navigate), a
      #           TypeError rejection
      # MIXED CONTENT is checked here rather than JS-side because "is this a secure context" is the
      # host's knowledge: an https client may not be navigated to http.
      # Queued, not performed here: `deliver_worker_messages` runs inside the `@ticking` guard, and
      # navigating rebuilds a realm (a top-level one rebuilds the whole context). Doing that
      # mid-drain would pull the rug from under the rest of the batch — the sw_msgs / claims /
      # fetch_resps still to be delivered would address realms that no longer exist — and from any
      # node handle an in-flight find is holding. `drain_pending_navigation` is where every other
      # navigation intent lands, well clear of the V8 call we are inside.
      def sw_navigate_client(handle, client_id, url, nav_id)
        (@sw_pending_client_navs ||= []) << {handle: handle.to_i, client: client_id.to_s, url: url.to_s, nav_id: nav_id.to_i}
        nil
      end

      def consume_pending_sw_client_nav
        return if @sw_pending_client_navs.nil? || @sw_pending_client_navs.empty?

        navs = @sw_pending_client_navs
        @sw_pending_client_navs = nil
        navs.each {|e| perform_sw_client_navigate(e[:handle], e[:client], e[:url], e[:nav_id]) }
        nil
      end

      private def perform_sw_client_navigate(handle, client_id, url, nav_id)
        realm_id = sw_client_realm(client_id)
        return sw_navigate_reply(handle, nav_id, '', '', 'the client is not a navigable browsing context') if realm_id.nil?

        from = client_realm_url(realm_id)
        return sw_navigate_reply(handle, nav_id, '', '', 'mixed content is not allowed') if mixed_content_navigation?(from, url)

        # Identify the browsing CONTEXT before navigating — a frame navigation rebuilds its realm,
        # so the realm id is not stable across it, but the iframe element that owns it is.
        parent    = realm_id.zero? ? nil : @runtime.frame_realm_parent(realm_id)
        container = realm_id.zero? ? nil : frame_container_handle(realm_id, parent)
        navigate_client_realm(realm_id, url)
        landed_realm = realm_id.zero? ? 0 : (realm_for_container(parent, container) || realm_id)
        landed       = client_realm_url(landed_realm)
        # A cross-origin result is reported as "no client": the spec resolves navigate() with null
        # rather than handing back a client this worker has no business seeing.
        origin = url_origin(landed)
        return sw_navigate_reply(handle, nav_id, '', '', nil) if landed.empty? || origin.nil? || origin != url_origin(from)

        # The client id is realm-derived, so the rebuild MOVED it. Reply with the id of the context
        # as it is NOW — handing back the pre-navigation id would give the worker a client whose
        # postMessage is silently dropped and whose focus() would point the focus chain at a
        # discarded realm (see the sw_clientid_model note).
        sw_navigate_reply(handle, nav_id, landed, sw_client_id(landed_realm), nil)
      rescue StandardError => e
        sw_navigate_reply(handle, nav_id, '', '', "navigation failed: #{e.message}")
      end

      private def sw_navigate_reply(handle, nav_id, url, client_id, error)
        w = @workers[handle.to_i] or return nil
        w[:inbox] << {kind: 'client_navigate_result', nav_id: nav_id.to_i, url: url.to_s, client: client_id.to_s, error: error.to_s}
        nil
      end

      # The realm currently backing a browsing context, named by the iframe element that owns it.
      # The element outlives every realm rebuild a navigation causes, so it — not the realm id —
      # is what identifies the context across one.
      private def realm_for_container(parent, container)
        return nil if container.nil? || container.zero?

        @runtime.frame_realm_ids.find do |rid|
          @runtime.frame_realm_alive?(rid) && frame_container_handle(rid, parent) == container
        rescue StandardError
          false
        end
      end

      private def client_realm_url(realm_id)
        (realm_id.to_i.zero? ? @current_url : frame_realm_url(realm_id)).to_s
      end

      # An https document may not be navigated to an http one (mixed content); the reverse, and
      # any non-http(s) scheme, is not this check's business.
      private def mixed_content_navigation?(from, to)
        from.to_s.downcase.start_with?('https://') && to.to_s.downcase.start_with?('http://')
      end

      # Re-navigate the browsing context behind a client id — the main window or a frame realm.
      private def navigate_client_realm(realm_id, url)
        return visit(url) if realm_id.zero?

        navigate_realm_self_get(realm_id, url, record: false)
      end

      # Drop a client whose realm was disposed (frame navigated away / removed) so
      # matchAll stops returning a dead client. No-op for an unregistered realm.
      def sw_unregister_client(realm_id)
        unregister_client(sw_client_id(realm_id))
        # Prune the disposed realm's adopted-id alias AFTER the record removal consumed it
        # (sw_client_id above resolves through the alias). Realm ids are never reused
        # (rusty's per-isolate counter is monotonic), so a stale pair is only growth —
        # but frame-realm churn is real (Discourse), so drop it eagerly.
        if (cid = @sw_realm_aliases.delete(realm_id.to_i))
          @sw_client_aliases.delete(cid)
        end
        nil
      end

      private def unregister_client(client_id)
        return nil unless Native.sw_forget_client(@sw_partition, client_id.to_s)

        # The departed client may have been the last one USING an unregistered registration — cleared
        # before anything activates (Handle Service Worker Client Unload: Try Clear Registration, then
        # Try Activate), so an unregistered registration's waiting worker goes redundant, not active.
        try_clear_uninstalls
        # Losing a controllee can be what finally lets a worker parked in `waiting` activate (the
        # non-skipWaiting half of "try activate").
        sw_try_activate
        nil
      end

      # Try Activate again for every worker standing at it — cheap when none does, as on the ordinary client-churn
      # path (rule 3).
      private def sw_try_activate
        @sw_step_waits.filter_map {|h, what| h if what == 'try_activate' }.each do |h|
          sw_resume_step(h, 'try_activate')
        end
      end

      # Handle Service Worker Client Unload for the outgoing document and its frames, as a navigation replaces them:
      # each no longer a client — which may let a waiting worker activate, or an unregistered registration clear.
      private def sw_unload_document_clients
        [*@runtime.frame_realm_ids, 0].each {|rid| sw_unregister_client(rid) }
      end

      # A browsing context was discarded. HTML hands focus back to the top-level traversable
      # when the focused navigable goes away, so a realm that held the focus chain must not
      # keep it — otherwise `WindowClient.focused` stays true for a client that no longer exists.
      def note_realm_discarded(realm_id)
        note_focused_realm(0) if @focused_realm_id == realm_id.to_i
        nil
      end

      # The focused BROWSING CONTEXT (HTML "focused area of the top-level traversable"):
      # the realm whose document owns the focus chain. Reported by the realm that commits a
      # focus — focusing an <iframe> hands focus to its NESTED context, so that realm is
      # reported rather than the container's. Feeds `WindowClient.focused` — the registry's, which a
      # service worker reads (it can't query the browser).
      def note_focused_realm(realm_id)
        rid = realm_id.to_i
        return nil if @focused_realm_id == rid

        @focused_realm_id = rid
        Native.sw_set_focused(@sw_partition, focused_client_ids)
        nil
      end

      # Every client id that counts as focused: the focused context AND its ANCESTORS.
      # `WindowClient.focused` follows `document.hasFocus()`, which is true for the whole chain
      # up from the focused frame — a page containing the focused iframe is itself focused
      # (clients-matchall-include-uncontrolled expects the top-level window and the focused
      # nested frame to BOTH report true). Not a single winner, despite the name of the field.
      def focused_client_ids
        return [] if @focused_realm_id.nil?

        ids = []
        rid = @focused_realm_id
        16.times do
          ids << sw_client_id(rid)
          # A top-level browsing context ends the chain: the main realm, and an auxiliary window
          # (whose OPENER is not its ancestor — `document.hasFocus()` is false in the opener while
          # the popup holds the focus, so its client must not be dragged in).
          break if @runtime.top_level_realm?(rid)

          rid = @runtime.frame_realm_parent(rid).to_i
        end
        ids.uniq
      end

      # A worker's service-worker Client id. Distinct from the realm ids below so the
      # client-message router can tell a worker client from a browsing context.
      def sw_worker_client_id(handle) = "client-#{@client_space}worker-#{handle.to_i}"

      # A realm's service-worker Client id, in this window's space (`@client_space`: none for the
      # session's first window). The MAIN realm (id 0) is 'client-window'; a realm that ADOPTED
      # a navigation's reserved client id reports that id; every other realm is `client-<realm>`. The same spellings are produced JS-side by sw-client.js's clientId()
      # (which prefers the injected `__csimClientId`) and the FetchEvent clientKey
      # (js/src/workers.js), and read back by the client-message router below — so they must
      # be minted in exactly one place.
      def sw_client_id(realm_id)
        return "client-#{@client_space}window" if realm_id.to_i.zero?

        @sw_realm_aliases[realm_id.to_i] || "client-#{@client_space}#{realm_id.to_i}"
      end

      # The realm a client id names — the inverse of `sw_client_id`, nil for an unrecognized id.
      def sw_client_realm(client_id)
        id = client_id.to_s
        return 0 if id == "client-#{@client_space}window"
        return @sw_client_aliases[id] if @sw_client_aliases.key?(id)

        (m = /\Aclient-#{Regexp.escape(@client_space)}(\d+)\z/.match(id)) ? m[1].to_i : nil
      end

      # One fresh reserved-client id (Service Workers "create a new environment settings
      # object" for a navigation) — see the @sw_resulting_seq comment.
      def mint_resulting_client_id = "client-#{@client_space}nav#{@sw_resulting_seq += 1}"

      # The committed document's realm ADOPTS the navigation's reserved client id (the
      # reserved client BECOMES the document's client). A rebuild of the same frame re-adopts
      # under the new realm id; the superseded alias is dropped so a stale id resolves nothing.
      def sw_adopt_client_id(realm_id, client_id)
        cid = client_id.to_s
        return if cid.empty? || realm_id.to_i.zero?

        if (old = @sw_realm_aliases[realm_id.to_i])
          @sw_client_aliases.delete(old)
        end
        @sw_realm_aliases[realm_id.to_i] = cid
        @sw_client_aliases[cid]          = realm_id.to_i
        nil
      end

      # The worker handle a client id names, or nil when the id is not a worker client's.
      def sw_client_worker(client_id)
        (m = /\Aclient-#{Regexp.escape(@client_space)}worker-(\d+)\z/.match(client_id.to_s)) ? m[1].to_i : nil
      end

      # ── Cross-isolate MessagePort channels ──
      # A channel's two ends, `<channel>/0` and `<channel>/1`, each held by a realm of this window (`[:realm, id]`) or by
      # a worker (`[:worker, handle]`) — whichever isolate holds the port at that end, which says so as it takes it
      # (`port_end_here`) and as it gives it up to another (`port_end_gone`). A message posted at one end goes to the
      # other's holder; one for an end no isolate holds yet waits for its next holder (HTML's port message queue) — the
      # messages its last holder had received and not delivered first.
      def port_end_here(end_id, at)
        port_end = (@port_ends[end_id.to_s] ||= {})
        return if port_end[:closed]
        port_end[:at] = at
        (port_end.delete(:pending) || []).each {|data| deliver_port_message(at, end_id.to_s, data) }
        nil
      end
      # (`from`: the holder giving it up — which is no longer the holder where its next one has taken it already: what
      # it held then goes to that one)
      def port_end_gone(end_id, held, from)
        port_end = (@port_ends[end_id.to_s] ||= {})
        held = Array(held).map(&:to_s)
        if port_end[:at] == from
          port_end[:at] = nil
          port_end[:pending] = held + port_end.fetch(:pending, [])
        else
          held.each {|data| port_receive(end_id.to_s, port_end, data) }
        end
        nil
      end
      # A message that reached an end's holder after it had given the end up — it was on its way — for the holder now.
      def port_redeliver(end_id, data)
        port_end = @port_ends[end_id.to_s] or return
        port_receive(end_id.to_s, port_end, data.to_s)
        nil
      end
      # A port closed at its end: nothing more is delivered to it, and an end whose other is closed too is forgotten.
      def port_end_closed(end_id)
        @port_ends[end_id.to_s] = {closed: true}
        other = port_other_end(end_id)
        if @port_ends.dig(other, :closed)
          @port_ends.delete(end_id.to_s)
          @port_ends.delete(other)
        end
        nil
      end
      # (`from`: the end it is posted at — none where that end is closed, or forgotten: a worker's post and its close
      # in one turn reach here after the close, its signals about ends being handled ahead of its messages)
      def port_post(from, data)
        return if @port_ends.fetch(from.to_s, {})[:closed] || !@port_ends.key?(from.to_s)
        to = port_other_end(from)
        port_receive(to, (@port_ends[to] ||= {}), data.to_s)
        nil
      end
      private def port_other_end(end_id) = end_id.to_s.sub(%r{/(\d)\z}) { "/#{1 - $1.to_i}" }
      # (…to its holder, or held for its next one — or nowhere, at a closed end)
      private def port_receive(end_id, port_end, data)
        return if port_end[:closed]
        if port_end[:at]
          deliver_port_message(port_end[:at], end_id, data)
        else
          (port_end[:pending] ||= []) << data
        end
      end
      # …into its holder: a realm's port (realm 0 the main one; a discarded frame's, nowhere), or a worker's by its inbox —
      # counted like an sw_message, which the worker acks once its handler ran, so a settle waits out its reply.
      private def deliver_port_message((kind, id), end_id, data)
        if kind == :worker
          w = @workers[id] or return
          @sw_message_pending += 1
          w[:inbox] << {kind: 'port_msg', end: end_id, data: data}
        elsif id.zero?
          @runtime.call('__csimPortEndDeliver', end_id, data)
        elsif @runtime.frame_realm_alive?(id)
          @runtime.realm_call(id, '__csimPortEndDeliver', end_id, data)
        end
      end

      # Whether THIS browser hosts the registration controlling a navigation to `url`
      # (Driver#sw_navigation_fetch probes each window's Browser with this).
      def sw_controls_navigation?(url) = !!sw_controller_for_navigation(url)

      # The scopes whose registered service worker thread is still alive — what a
      # navigation can actually be routed to (Driver#sw_navigation_fetch dedup +
      # parked-browser reclaim read this).
      def sw_live_scopes
        sw_serving.select {|_scope, h| @workers[h]&.[](:thread)&.alive? }.keys
      end

      # Whether this browser still hosts a live service-worker registration — a closing
      # window with one is parked by the driver (registrations outlive their documents)
      # rather than disposed. A live SERVICE worker thread counts even before its scope
      # is its registration's active worker (that arrives from a lifecycle
      # step, a task later — a page that registers and closes immediately must
      # not have its SW disposed by the race).
      def sw_registrations_active?
        !sw_live_scopes.empty? || @workers.any? {|_h, w| w[:service] && w[:thread]&.alive? }
      end

      # Trimmed teardown for a browser being PARKED (window closed, live SW kept): kill
      # everything DOCUMENT-scoped — non-service workers, SSE / WebSocket / hijacked-
      # fetch reader threads — and drop the dead document (and its workers) from the SW
      # client set, so `clients.matchAll` stops returning a destroyed client. What
      # survives is exactly what sw_navigation_fetch needs: the SW worker threads, the
      # scope registry, and the driver-shared jars. A parked browser's message pump
      # never runs again (see Driver#sw_navigation_fetch's dead-letter drop; its
      # BroadcastChannel fan-out membership also ends — a parked SW's BC listener is
      # unreachable, a documented gap with no in-scope observer).
      def park_for_service_workers!
        @workers.reject {|_h, w| w[:service] }.keys.each {|h| worker_terminate(h) }
        reset_event_sources
        reset_websockets
        reset_hijacked_fetches
        Native.sw_clients(@sw_partition).each {|id, *| unregister_client(id) }
        # …and the agents its realms were — their IndexedDB connections, which a closed window's are not left open by, and
        # their locks: no other window's upgrade or lock request waits on a page nothing runs any more.
        @runtime.call('__csimAgentsDrop')
      end

      # Drop the parked browser's queued worker→main messages (claims, client
      # postMessages, port frames): nobody pumps a parked browser, so they'd otherwise
      # accumulate for the session — and their audience (the closed document) is gone.
      # The navigation respondWith rides its own @sw_nav_outbox, already consumed.
      def drop_dead_letter_worker_messages
        @worker_outbox.clear
      end

      # Route a navigation through the controlling SW across the WHOLE window set (the
      # registration may live in another window's Browser — or a parked one). Falls back
      # to this browser's own registry when driverless (unit specs build bare Browsers).
      def any_window_sw_navigation_fetch(url, **kw)
        return @driver.sw_navigation_fetch(url, **kw) if @driver.respond_to?(:sw_navigation_fetch)

        service_worker_navigation_fetch(url, **kw)
      end

      # One navigation fetch for a FRAME load — the bridge's __csimFrameWindow build
      # (GET) and a form submission to a named frame (POST, fetch.js mode 'navigate'):
      # per hop, consult the controlling SW across the whole window set (a redirect
      # out of one SW's scope can land in another registration's — or on the
      # network), then fall through to a network navigation request; FOLLOW
      # redirects by re-entering interception at each new URL (301/302 of a POST and
      # 303 of a non-GET/HEAD rewrite the next hop to a bodyless GET — Fetch
      # "HTTP-redirect fetch" — so a redirected form POST "must clear body"; 307/308
      # re-POST). Returns __rackFetch's response wire shape (the JS frame builder
      # reads body / headers / url / redirected / charset), or nil for a failed
      # navigation (respondWith network error / redirect loop).
      def frame_navigation_fetch(url, referrer_source, is_reload: false, secure_ancestors: true, method: 'GET', body: nil, content_type: nil, defer_ok: false, dest: 'iframe', container_realm: nil)
        # Handle Fetch: a navigation into a scope whose worker is still 'activating' (its
        # activate waitUntil unsettled) WAITS for activation (fetch-waits-for-activate).
        # The main thread can't block for it — the settling message is sent by this very
        # page's JS — so the iframe build path (`defer_ok`, the only caller that can park
        # cleanly) gets a deferral marker: the builder shelves the frame element and the
        # activated marker replays the build (__csim_swRetryDeferredNavs). Other callers
        # (form POST to a named frame) dispatch immediately, as before.
        if defer_ok && sw_activating_controller_for(url)
          @sw_navs_deferred = true
          return {'deferred' => true}
        end
        target      = url.to_s
        initiator   = referrer_source
        meth        = method.to_s.empty? ? 'GET' : method.to_s.upcase
        req_body    = body.to_s.b
        req_ct      = content_type
        site        = nil
        origin_null = false
        redirected  = false
        # The navigation's reserved client id (`event.resultingClientId`): every hop of the
        # chain carries the SAME id — re-minted when a hop crosses origins (a reserved client
        # is origin-bound) — and the committed document's realm adopts the final one.
        rid         = mint_resulting_client_id
        (MAX_FETCH_REDIRECTS + 1).times do
          resp_body = nil
          # (…cross-site for cookies where the document the frame is in, or one of ITS ancestors, is: RFC 6265bis "site
          # for cookies" — the realm building it, when it says which)
          cookie_cross = !container_realm.nil? && container_cross_site?(container_realm, target)
          # A service worker only controls a client whose EVERY ancestor is a secure
          # context: an httpS frame anywhere under an http document loads from the
          # network (secure-context.https). Gated on the target being https — a scope
          # prefix-matches its client URL, so this is exactly "an https REGISTRATION
          # never controls an insecure context" — because the driver's model treats a
          # plain-http world (the app suites at http://www.example.com, where
          # isSecureContext is hard-true) as secure by fiat. The JS caller computes
          # the ancestor chain (it IS the chain — the building realm is the parent).
          if (secure_ancestors || !target.start_with?('https://')) &&
             (sw = any_window_sw_navigation_fetch(target, method: meth, body: req_body, content_type: req_ct, is_reload: is_reload, dest: dest,
                                                          referrer_source: initiator, site_seed: site, origin_null: origin_null, resulting_client_id: rid,
                                                          cookie_cross_site: cookie_cross))
            return nil if sw['networkError']

            status  = (sw['status'] || 200).to_i
            headers = sw['headers'] || {}
            body    = Base64.decode64(sw['body_b64'].to_s)
          else
            response = dispatch_navigation_request(
              target,
              method:            meth,
              initiator:         initiator,
              referrer_policy:   nil,
              site:              widen_sec_fetch_site(site, sec_fetch_site(initiator, target)),
              origin_null:       origin_null,
              body:              req_body.empty? ? nil : req_body,
              content_type:      req_ct,
              dest:              dest,
              cookie_cross_site: cookie_cross
            ) or return nil
            status, headers, resp_body = response
            body = nil   # read only for the terminal hop, below
          end
          if (loc = redirect_location(status, headers))
            resp_body.close if resp_body.respond_to?(:close)
            site        = widen_sec_fetch_site(site, sec_fetch_site(initiator, target))
            next_url    = carry_fragment(target, resolve_against(loc, target))
            origin_null = redirect_taints_origin?(origin_null, initiator, target, next_url)
            if Native.redirect_to_get(status.to_i, meth)
              meth     = 'GET'
              req_body = ''.b
              req_ct   = nil
            end
            rid         = mint_resulting_client_id if url_origin(next_url) != url_origin(target)
            target      = next_url
            redirected  = true
            next
          end
          body ||= read_rack_body(resp_body)
          out = response_hash(status, headers, body, target, redirected)
          # The final reserved client id — the JS frame builder hands it to the new realm
          # (create_frame_realm injects `__csimClientId` + records the adoption).
          out['resulting_client_id'] = rid if out
          return out
        end
        nil   # redirect loop → failed navigation
      end

      # Whether a service worker may control a navigation of realm `realm_id`'s own navigable — the engine's
      # (navigables.rs `sw_may_control_navigation`: a secure context by its top-level creation URL, no origin a sandbox
      # makes opaque) — none of a frame realm gone (whose answer the main realm's would stand in for).
      private def sw_may_control_frame_navigation?(realm_id)
        id = realm_id.to_i
        return false if id.positive? && !@runtime.frame_realm_alive?(id)

        @runtime.realm_call(id, '__csimSwMayControlNavigation') == true
      end

      # The active fetch-handling worker controlling a navigation to `url`. nil when uncontrolled
      # or the SW is known to have no fetch listener (→ load from the network).
      private def sw_controller_for_navigation(url) = sw_navigation_match(url)&.first

      # …and the scope of the registration it is of, [handle, scope] — whose navigation preload state applies.
      private def sw_navigation_match(url)
        match = sw_scope_match(url) or return nil
        handle = match[0]
        w = @workers[handle] or return nil
        # has_fetch is published from the worker thread AFTER its initial eval, so a navigation
        # into a freshly-activated registration can read it as nil (unknown) — race-prone for the
        # 2nd+ registration, whose initial load fires before the publish. Treat unknown as "maybe":
        # route through and let the fetch dispatch fall through if the SW turns out to have no
        # handler. Skip only a KNOWN-false (messaging/push-only) SW — unless it registered
        # Static Routing rules, which route requests with no fetch handler at all
        # (static-router-no-fetch-handler) — or one whose thread is already DEAD (crashed
        # during eval / closed) — routing there would just stall the nav for the full
        # round-trip budget with no one to answer.
        return nil if !sw_interception_worthy?(w) || !w[:thread]&.alive?

        match
      end

      # Route a navigation request (document / iframe load) to its controlling SW's `fetch`
      # event and BLOCK for the respondWith result. Mirrors settle's bounded wait: the main
      # thread releases the GVL on the dedicated `@sw_nav_outbox`, so the worker thread runs the
      # handler and posts back. Navigation ids are NEGATIVE so the response is delivered on that
      # queue (sw_deliver_fetch_response), not the general outbox. Returns the parsed response
      # hash (SW served the document), or nil to load from the network (no controller, no
      # respondWith, network error, or the SW didn't answer within the round-trip budget).
      def service_worker_navigation_fetch(url, is_reload: false, is_history: false, referrer_source: nil, referrer_policy: nil, method: 'GET', body: nil, content_type: nil, site_seed: nil, origin_null: false, dest: 'iframe', cookie_cross_site: false, resulting_client_id: nil)
        match = sw_navigation_match(url) or return nil
        handle, preload_scope = match
        w      = @workers[handle] or return nil
        fetch_id = (@sw_nav_seq -= 1)
        # Navigation Preload: when the controlling registration has it enabled, issue the parallel
        # preload request NOW (main thread, before dispatching the event) and hand the response to the
        # SW as `event.preloadResponse`. GET only (the feature does not support other methods). The SW
        # that serves `respondWith(event.preloadResponse)` echoes this response back — the server is hit
        # exactly once. (EARNED GAP: if the SW instead FALLS THROUGH, this method returns nil and the
        # caller re-fetches from the network — a second hit; the spec reuses the preload response for
        # the fall-through. No vendored subtest enables preload then falls through.)
        # `dest` distinguishes a TOP-LEVEL navigation ('document') from a frame's ('iframe'):
        # the preload request must report the navigation's own Sec-Fetch-Dest — the SameSite
        # Lax cookie gate only applies to a top-level document GET.
        preload = if method.to_s.upcase == 'GET' && nav_preload_enabled?(preload_scope)
          navigation_preload_response(
            url,
            referrer_source,
            referrer_policy,
            site_seed,
            origin_null,
            nav_preload_state(preload_scope)['headerValue'],
            dest:              dest,
            cookie_cross_site: cookie_cross_site
          )
        end
        # A form submission navigates with the form's method + encoded body (a POST nav the SW reads
        # via `event.request.text()`); the Content-Type the form's enctype implies rides its headers.
        headers = {'Accept' => 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'}
        headers['Content-Type'] = content_type.to_s unless content_type.to_s.empty?
        req = JSON.generate(
          method:              method.to_s.empty? ? 'GET' : method.to_s.upcase,
          url:                 url.to_s,
          # The Accept header Fetch inserts for a navigation request (destination 'document').
          headers:             headers,
          # The request wire is JSON text, so the body's bytes travel as base64 in it.
          body_b64:            Base64.strict_encode64(body.to_s),
          mode:                'navigate',
          # The navigation's real destination — 'document' for a top-level navigation,
          # 'iframe' for a frame's (event.request.destination distinguishes them, and a
          # passthrough re-fetch reports it as Sec-Fetch-Dest + gates the Lax cookie
          # exception, which is top-level-only).
          destination:         dest.to_s,
          isReloadNavigation:  is_reload,
          isHistoryNavigation: is_history,
          # A navigation request's redirect mode is 'manual' (Fetch "create navigation request"):
          # `event.request.redirect === 'manual'`, and a passthrough `fetch(event.request)` of a
          # redirecting URL yields an opaqueredirect — which the navigation normalization below
          # FOLLOWS (the private redirect_loc channel), so the SW observes every hop.
          redirect:            'manual',
          # A reload navigation revalidates (cache mode 'no-cache'); a fresh/history load is 'default'.
          cache:               is_reload ? 'no-cache' : 'default',
          # The navigation's referrer is the initiating document, resolved under ITS Referrer-Policy
          # (the document default absent a meta/header — strict-origin-when-cross-origin — so a
          # same-origin nav keeps the full URL). A SW that re-issues the request
          # (`fetch(event.request)`) computes Sec-Fetch-Site / Origin against this referrer's origin.
          referrer:            compute_referrer(referrer_policy, referrer_source, url.to_s).to_s,
          # `event.request.referrerPolicy` reflects the RESOLVED policy: a navigation with no explicit
          # meta/header policy uses the document default (strict-origin-when-cross-origin), never the
          # empty string a bare Request would carry (fetch-event-referrer-policy "default referrer policy").
          referrerPolicy:      referrer_policy.to_s.empty? ? DEFAULT_REFERRER_POLICY : referrer_policy.to_s,
          # A passthrough `fetch(event.request)` re-fetch reports the navigation's OWN request
          # metadata to the server, independent of the referrer (which Referrer-Policy may reduce):
          # the initiator origin (the navigating frame's — the request's origin for the Origin
          # header) and the redirect chain's latched Sec-Fetch-Site seed / Origin taint accumulated
          # by the network hops before the SW intercepted the final URL.
          initiator:           url_origin(referrer_source),
          siteSeed:            site_seed,
          originNull:          origin_null,
          # The ancestor-chain cookie verdict of the frame this navigation commits into
          # (RFC 6265bis site-for-cookies). A property of the TARGET FRAME, not the
          # request: it survives a SW's `new Request(event.request, init)` rewrite —
          # unlike the initiator, which the copy resets to the SW's own origin.
          cookieCrossSite:     cookie_cross_site,
          # The navigation's RESERVED client id (`event.resultingClientId`): one per navigation
          # chain, re-minted across a cross-origin redirect hop, adopted by the committed
          # document (mint_resulting_client_id / sw_adopt_client_id). nil → the worker falls
          # back to its realm-derived key (a caller that doesn't thread the chain id yet).
          resultingClientId:   resulting_client_id,
          # The Navigation Preload response (nil unless preload is enabled), surfaced to the handler
          # as `event.preloadResponse`.
          preloadResponse:     preload
        )
        w[:inbox] << {kind: 'fetch', req:, fetch_id:}
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + WORKER_ROUND_TRIP_BUDGET
        # A race-network-and-fetch-handler route's pre-fetched network leg (the
        # worker posts it just before dispatching the handler — see
        # sw_race_network): held here until the handler answers, when the
        # modeled-delay comparison picks the winner.
        race_leg = nil
        while Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
          ev = pop_with_timeout(@sw_nav_outbox, WORKER_POLL_INTERVAL) or next
          next unless ev[:fetch_id] == fetch_id   # discard a stale response from a timed-out nav

          if ev[:race_leg]
            race_leg = ev[:race_leg]
            next
          end

          resp = JSON.parse(ev[:resp])
          # The race decision, mirroring sw_race_take_network_win: the network
          # leg wins when the server's modeled delay undercuts the handler's
          # measured span, or when the handler fell through with a usable leg.
          from_network = false
          if race_leg
            leg      = race_leg
            race_leg = nil
            if leg[:resp] && (resp['fallthrough'] ||
                              leg[:server_ms].to_f < (Process.clock_gettime(Process::CLOCK_MONOTONIC) - leg[:t0]) * 1000.0)
              resp         = JSON.parse(leg[:resp])
              from_network = true
            end
          end
          return nil                        if !from_network && resp['fallthrough']   # no respondWith → load from the network
          return {'networkError' => true}   if resp['networkError']   # respondWith(Response.error()) → failed navigation
          # Response-to-request validity applies to a respondWith, NOT to the race
          # NETWORK leg — that is the network's own answer: it followed its
          # redirects itself and commits at the final URL like any network nav.
          unless from_network
            # HTTP fetch response-to-request validity for a navigation request — mode 'navigate',
            # redirect 'manual': an OPAQUE response (a document never commits from a no-cors
            # response) or a REDIRECTED one (the SW re-fetched with 'follow' and a redirect occurred)
            # is a network error; only an opaqueredirect (below) may carry a redirect to a nav.
            return {'networkError' => true} unless sw_response_allowed?(resp, 'navigate', 'manual')
          end
          # An opaque-REDIRECT respondWith: the navigation processes the real redirect the
          # filtered surface (status 0 / empty headers) hides, carried on the private wire
          # fields (opaque_redirect_hash). Rewrite the real values in, so every caller's
          # existing redirect-follow / document-commit pipeline works unchanged: a Location →
          # the chain re-enters interception at it (real status drives the 307/308 re-POST
          # split); a redirect status with NO Location → the body commits as the document at
          # the request URL (Chrome's behavior — navigation-redirect "No location redirect").
          if resp['type'] == 'opaqueredirect'
            resp = if resp['redirect_loc'].to_s.empty?
              resp.merge(
                'status'   => resp['redirect_status'].to_i,
                'headers'  => {'content-type' => resp['redirect_ct'].to_s},
                'body_b64' => resp['render_b64'].to_s
              )
            else
              resp.merge(
                'status'  => resp['redirect_status'].to_i,
                'headers' => {'location' => resp['redirect_loc'].to_s}
              )
            end
          end
          return resp
        end
        # SW never answered within budget: a pre-fetched race leg is the
        # network's answer already in hand; otherwise nil → the caller loads
        # from the network itself.
        race_leg && race_leg[:resp] ? JSON.parse(race_leg[:resp]) : nil
      end

      def worker_terminate(handle)
        w = @workers.delete(handle.to_i)
        return unless w
        # A parent worker takes its NESTED workers with it (their Worker objects lived in
        # its isolate — no one can reach them once it's gone).
        @workers.select {|_h, cw| cw[:parent_worker] == handle.to_i }.each_key {|child| worker_terminate(child) }
        detach_worker(handle.to_i, w)
        # Most clean shutdowns are <10 ms; the kill is the fallback
        # for blocked workers. Join again AFTER the kill so the thread is actually
        # dead before we revoke its URLs — `Thread#kill` is async, and a worker
        # still running a `createObjectURL` could otherwise re-register a URL after
        # the revoke and leak it.
        # `&.`: a record inserted by worker_spawn before its Thread.new has `thread: nil`
        # for one statement — treat it as already gone, like every other liveness check.
        w[:thread]&.join(WORKER_TERMINATE_GRACE)
        # Still there: it is inside JS (or a host fn), where the `:terminate` message cannot reach
        # it and a kill cannot land. Stop the JS half, and only then fall back to the kill.
        if w[:thread]&.alive?
          stop_worker_wait(w)
          w[:thread].join(WORKER_TERMINATE_GRACE)
        end
        reap_worker(handle.to_i, w)
      end

      # Ask a worker to stop and stop treating it as a client. Split out of `worker_terminate` so the
      # realm-disposal path can do it WITHOUT the thread joins below (see terminate_realm_workers).
      # A dedicated / shared worker is a service-worker client (worker_spawn registers it), and a
      # terminated one must stop showing up in matchAll — the same leak sw_unregister_client
      # prevents for a disposed realm. A no-op for a SERVICE worker, which is never a client.
      private def detach_worker(handle, w)
        unregister_client(sw_worker_client_id(handle))
        w[:inbox] << :terminate
      end

      # Stop the worker's JS half, from the thread that wants it gone. `Thread#kill` cannot do this
      # job, in two different ways: a kill that lands while the thread is inside V8 running JS is
      # not delivered until that call RETURNS, and a kill that lands inside a HOST FUNCTION does not
      # kill the thread at all — it surfaces as `RustyRacer::RuntimeError: Error: Fatal` from the
      # call in flight and the thread runs on, with CRuby already treating it as killed so a second
      # kill is a no-op (rusty_racer 0.2.3's documented contract; 0.2.2 tried to make the kill mean
      # something there and segfaulted the suite instead).
      #
      # `Isolate#terminate` is the tool for that half — thread-safe by design, non-blocking, and
      # already how the call-timeout watchdog stops a runaway. Measured: a worker inside a 400 ms
      # spin on a repeating timer made `reset!` take 4.0 s every time; with this it is 0.0 s in 4
      # runs out of 5.
      private def stop_worker_js(w)
        return unless w && (lock = w[:rt_lock])
        # Set the flag FIRST: it is what stops a worker that is between calls right now, and
        # `terminate` cannot help there — there is nothing running to terminate, and the flag it
        # sets does not survive to the next call. Measured, without it: one tick in four landed
        # between calls and then spent 4.0 s inside a single `drain_timers` (its 50 ms budget is
        # checked BETWEEN callbacks, and one callback here runs 400 ms).
        w[:stopping] = true
        # `try_lock`, not `synchronize`: the only other holder is the worker's own `ensure`,
        # disposing the isolate — which is the outcome this method wants, and which takes long
        # enough (watchdog shutdown, thread join, isolate drop) to blow the caller's grace.
        return unless lock.try_lock
        begin
          w[:rt]&.terminate
        ensure
          lock.unlock
        end
      rescue StandardError
        nil
      end

      # Ask, and keep asking for one grace period, until the worker's thread is gone — then kill as
      # the last resort. The RE-ask is what makes this reliable: `terminate` only bites while the
      # isolate is actually executing, so a stop that arrives while the worker is in Ruby (between
      # its own JS calls, in a host fn, at its inbox) does nothing, and the worker is free to enter
      # another seconds-long call. Re-asking every few ms means whichever call it enters next is
      # the one that ends.
      private def stop_worker_wait(w)
        t = w[:thread]
        return if t.nil?
        # Nothing to re-ask — this worker never got as far as publishing a runtime. Waiting out the
        # grace there is pure delay; `Thread#kill` lands on a thread that is not inside a call.
        unless worker_runtime_published?(w)
          t.kill if t.alive?
          return
        end
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + WORKER_TERMINATE_GRACE
        while t.alive? && (left = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)) > 0
          stop_worker_js(w)
          t.join(left < 0.005 ? left : 0.005)
        end
        t.kill if t.alive?
      end

      private def worker_runtime_published?(w)
        w[:rt_lock].synchronize { !w[:rt].nil? }
      rescue StandardError
        false
      end

      # Everything that must happen once a worker is out of `@workers`, whether or not we waited for
      # its thread: drain what it will never answer, release the counters it still holds, and revoke
      # what it created. Load-bearing — the counter reset at the end only fires when the LAST worker
      # goes, so skipping this path leaves `polling?` stuck true for the rest of the session and
      # every later negative assertion burns the full wait.
      private def reap_worker(handle, w)
        # A worker that dies still 'activating' releases what Handle Fetch parked on its
        # activation: deferred subresource fetches fall through to the network (queue pushes
        # + counter under the lock — safe from any thread), and a marker rides the outbox so
        # the MAIN thread forgets it as an activating worker and replays deferred
        # frame navigations — a reap can run on a worker thread (a parent worker's nested
        # Worker#terminate cascade), where mutating the map races
        # sw_activating_controller_for's iteration and broadcast_to_realms may not enter
        # realms at all. Same outbox pattern as sw_try_activate.
        flush_sw_deferred_fetches(handle, record: w, fallthrough: true)
        @worker_outbox << {handle: handle.to_i, kind: 'sw_reaped'} if w[:service]
        # Its agents gone: the locks it held let go, its IndexedDB connections closed (agents.rs `drop_owner`).
        Native.agents_drop_owner(w[:agent_owner]) if w[:agent_owner]
        # Hand back every plain postMessage this worker still owes a reply for — queued OR already
        # consumed by a listen-only handler that will never answer. Only a reply releases these,
        # and a dead worker sends none; leaving them counted pins `worker_pending?` (and so
        # `polling?`) true for the rest of the session, making every later negative assertion wait
        # out the full timeout.
        @worker_in_flight = [0, @worker_in_flight - w[:in_flight].to_i].max
        w[:in_flight] = 0
        # The dead worker never answers what was still queued in its inbox: post the matching
        # fallback replies so the reply-pending counters drain (a controlled fetch falls back to
        # the network) instead of taxing every later settle's bounded wait. Mid-dispatch deaths
        # are covered by the `ensure` acks in run_worker; only a respondWith parked on a worker
        # timer that never fires can still strand a fetch (the client promise then just never
        # settles, like a real dead SW).
        until w[:inbox].empty?
          msg = begin
            w[:inbox].pop(true)
          rescue ThreadError
            break
          end
          next unless msg.is_a?(Hash)
          case msg[:kind]
          when 'sw_message', 'port_msg' then @worker_outbox << {handle: handle.to_i, kind: 'swack'}
          when 'broadcast'  then @worker_outbox << {handle: handle.to_i, kind: 'bcack'}
          when 'fetch'      then sw_deliver_fetch_response(handle.to_i, msg[:fetch_id].to_i, '{"fallthrough":true}', @worker_outbox, msg[:realm_id].to_i)
          end
        end
        # A streaming respondWith whose worker died mid-body never emits its terminal frame: error the
        # client's stream (so a pending body read rejects, not hangs) and release the @sw_fetch_pending
        # each open stream still holds, so settle can reach idle.
        open = @sw_open_streams.delete(handle.to_i)
        if open&.any?
          open.each_key do |realm_id, fetch_id|
            @runtime.realm_call(realm_id, '__csim_swFetchStreamError', fetch_id)
          end
          @sw_fetch_pending = [0, @sw_fetch_pending - open.size].max
        end
        # A registration whose active worker this was routes no later navigation to it (it falls
        # through to the network instead).
        Native.sw_forget_worker(@sw_partition, handle.to_i)
        # A blocked worker that never returned messages leaves
        # `@worker_in_flight` permanently > 0; reset when no workers
        # remain so `polling?` can short-circuit again.
        (@worker_in_flight = 0; @worker_broadcast_pending = 0; @sw_message_pending = 0; @sw_fetch_pending = 0; @sw_fetch_wait_deadline = nil; @sw_msg_wait_deadline = nil; @port_ends = {}; @sw_pending_claims = []; @sw_open_streams.clear) if @workers.empty?
        # The worker is gone — revoke the blob URLs it created.
        revoke_worker_blobs(handle.to_i)
        # A dead SERVICE worker's holds are cleared with its record (extended / sw_msgs read
        # false once it's gone, and its scopes were just dropped): that is a hold-clearing
        # transition like any other, so it must post its wakeup — a candidate parked on a
        # now-dead outgoing worker would otherwise only resume on unrelated client churn.
        # Rides the outbox (thread-safe; sw_try_activate is a no-op where nothing waits).
        @worker_outbox << {handle: handle.to_i, kind: 'sw_try_activate'} if w[:service]
      end

      def deliver_worker_messages
        head = @worker_outbox_head
        @worker_outbox_head = nil
        return 0 if head.nil? && @workers.empty? && @worker_outbox.empty?
        events = drain_queue(@worker_outbox)
        events.unshift(head) if head
        return 0 if events.empty?
        # A worker-originated BroadcastChannel post ('broadcast') is fanned out on the main thread and
        # is NOT a reply. A 'bcack' acknowledges a broadcast the worker just delivered → release one
        # broadcast-pending. Everything else ('message'/'__error') is a postMessage reply.
        broadcasts,  rest0  = events.partition {|e| e[:kind] == 'broadcast' }
        port_ends,   rest0b = rest0.partition  {|e| PORT_END_KINDS.include?(e[:kind]) }
        port_msgs,   rest0c = rest0b.partition {|e| e[:kind] == 'port_msg' }
        sw_navs,     rest0c3 = rest0c.partition {|e| e[:kind] == 'sw_client_navigate' }
        skip_waits,  rest0d0 = rest0c3.partition {|e| e[:kind] == 'sw_skip_waiting' }
        sw_unregs,   rest0d0b = rest0d0.partition {|e| e[:kind] == 'sw_unregister' }
        sw_evals,    rest0d1 = rest0d0b.partition {|e| e[:kind] == 'sw_eval' }
        sw_phases,   rest0d2 = rest0d1.partition {|e| e[:kind] == 'sw_phase' }
        sw_reaps,    rest0d2b = rest0d2.partition {|e| e[:kind] == 'sw_reaped' }
        try_acts,    rest0d  = rest0d2b.partition {|e| e[:kind] == 'sw_try_activate' }
        sw_msgs,     rest1  = rest0d.partition {|e| e[:kind] == 'sw_client_msg' }
        swacks,      rest2  = rest1.partition  {|e| e[:kind] == 'swack' }
        claims,      rest3  = rest2.partition  {|e| e[:kind] == 'sw_claim' }
        fetch_resps,   rest4  = rest3.partition  {|e| e[:kind] == 'fetch_response' }
        stream_frames, rest4b = rest4.partition  {|e| e[:kind].to_s.start_with?('fr_') }
        acks,          msgs   = rest4b.partition {|e| e[:kind] == 'bcack' }
        broadcasts.each {|e| broadcast_to_windows(e[:name], e[:data], nil, e[:origin], from_worker: e[:handle]) }
        # A worker taking a MessagePort channel's end, or giving one up — in the order it did — BEFORE
        # the message events below, so a port message carried in the same drain can already route.
        port_ends.each do |e|
          case e[:kind]
          when 'port_here'      then port_end_here(e[:end], [:worker, e[:handle]])
          when 'port_gone'      then port_end_gone(e[:end], e[:held], [:worker, e[:handle]])
          when 'port_closed'    then port_end_closed(e[:end])
          when 'port_redeliver' then port_redeliver(e[:end], e[:data])
          end
        end
        # `WindowClient.navigate()` — only QUEUED here (see sw_navigate_client). It must not run
        # before the sw_msgs / claims / fetch_resps below: the worker emitted those FIRST, and a
        # navigation discards the realm they address. Queuing preserves the worker's own ordering
        # and keeps the realm rebuild out of the `@ticking` guard.
        sw_navs.each {|e| sw_navigate_client(e[:handle], e[:client], e[:url], e[:nav_id]) }
        # A SERVICE WORKER's own `registration.unregister()` — an Unregister job at its scope,
        # as the client-side call is. One its worker made while evaluating queues behind that
        # worker's own Register job, so it unregisters the registration the job leaves there —
        # the one that job made, or, the evaluation failed, the one there before. Scheduled
        # BEFORE the outcomes below: a failed one ends its worker, whose scope this reads.
        sw_unregs.each {|e| process_worker_unregister(e[:handle].to_i) }
        # A service worker's script-evaluation outcome — settles the Register / Update job
        # waiting on it (sw_job_evaluated), which makes the worker its registration's
        # installing worker. Delivered BEFORE skip_waits: a worker's install-phase skipWaiting()
        # can land in the same drain batch, and its lifecycle must have begun to take it
        # (skip-waiting "both active and waiting" hang).
        sw_evals.each {|e| sw_job_evaluated(e[:handle].to_i, e[:ok], e[:msg]) }
        # clients.claim(): the claiming worker takes control of EVERY in-scope client — including
        # ones that never register()'d (an iframe built before the SW existed). See broadcast_claim.
        # Processed BEFORE the phase markers below: the worker emits its activate-handler claim
        # ahead of its 'sw_phase', and the phase marker is what resumes the client-side
        # 'activated' step — a claim handled after it would let `wait_for_state(..., 'activated')`
        # resolve with the claimed frame's controller still unset (the activation.https flake;
        # a first activation buffers the claim, and only the phase-resumed step's
        # sw_register_scope flush applies it in time).
        # Process LONGEST scope first: when nested-scope workers claim in the same drain, the deeper
        # registration must be installed before the shallower one runs, or a client the shallow claim
        # transiently seizes would fire a spurious extra controllerchange (a reload-on-controllerchange
        # page would double-fire). A claim whose worker isn't its scope's active one yet — the
        # worker fires activate→claim() decoupled from the lifecycle step that populates it — is
        # BUFFERED and flushed by sw_register_scope, so an `activate → clients.claim()` isn't lost.
        # TRADEOFF: partition processing can't keep both claim<phase and message<claim, so a
        # worker's same-turn `client.postMessage(x); clients.claim()` now delivers the claim's
        # controllerchange BEFORE message x (these are separate task sources in a real browser;
        # no ordering contract is broken, but it inverts the previous within-batch order).
        # An ACTIVATING worker's claim applies immediately too (claim is valid from state
        # 'activating'; fetch-waits-for-activate claims mid-activate and expects the client
        # controlled — its fetches then park on the activation, not the claim).
        actives, activatings = sw_serving, sw_activatings
        claims.map {|e| [e, actives.key(e[:handle].to_i) || activatings.key(e[:handle].to_i)] }
              .sort_by {|_e, scope| -(scope ? scope.length : -1) }
              .each do |e, scope|
          if scope
            broadcast_claim(e[:handle], e[:has_fetch], scope)
          else
            @sw_pending_claims << e
          end
        end
        # A worker finished a lifecycle phase — its lifecycle parks its observable states on
        # these: 'installed' on the install marker (whose `ok:false` — a rejected install
        # waitUntil — fails the version to redundant instead), and 'activated' on the activated
        # marker (its claims are handled just above / flushed by the resumed step's
        # sw_register_scope, so they are in place before the state is observable). The activated
        # marker also releases the functional events Handle Fetch parked while the worker was
        # 'activating' (fetch-waits-for-activate): the record flag flips FIRST (new dispatches
        # stop deferring), then the resumed step makes it the worker serving its scope, then the
        # parked fetches/navigations replay against the now-complete state.
        sw_phases.each do |e|
          h     = e[:handle].to_i
          phase = e[:phase].to_s
          if phase == 'activated' && (w = @workers[h])
            @worker_init_lock.synchronize { w[:sw_activated] = true }
          end
          Native.sw_note_phase(@sw_partition, h, phase, !e.key?(:ok) || e[:ok])
          sw_resume_step(h, phase == 'install' ? 'install' : 'activation')
        end
        sw_phases.each do |e|
          next unless e[:phase].to_s == 'activated'

          flush_sw_deferred_fetches(e[:handle].to_i)
          retry_deferred_navigations
        end
        # A reaped SERVICE worker (posted by reap_worker, possibly from a worker thread):
        # main-thread cleanup of the activation-parking state it can no longer satisfy.
        # A job its worker owed an evaluation outcome fails with it (its worker thread posts the
        # outcome before it exits, so one still owed never comes), and a job waiting for its
        # install runs — neither may hold its scope's queue for good.
        sw_reaps.each do |e|
          h = e[:handle].to_i
          Native.sw_forget_activating(@sw_partition, h)
          retry_deferred_navigations
          if (id = @sw_job_evals.delete(h))
            kind, = Native.sw_job(@sw_partition, id)
            sw_settle_job(id, 'TypeError', "Failed to #{kind} a ServiceWorker: the worker ended before its script evaluated.")
          end
          if (id = @sw_jobs_behind.delete(h))
            sw_queue_job(id)
          end
        end
        # `skipWaiting()` — Try Activate again for the worker (the flag is host state, recorded before
        # this marker was even queued — sw_may_activate? reads it).
        skip_waits.each {|e| sw_resume_step(e[:handle].to_i, 'try_activate') }
        # A worker's extended-lifetime work drained to 0 — a successor parked in
        # `waiting` may now activate (the waitUntil half of "try activate"; the
        # controllee half fires from unregister_client).
        # The drained work may have been the last hold on a deferred unregister's clear — cleared
        # first, as at a client's unload (unregister_client).
        try_clear_uninstalls if try_acts.any?
        sw_try_activate if try_acts.any?
        # A worker's port → the other end of its channel: a realm's, a worker's, or none yet (held for it —
        # a client decodes a transferred port in the sw_client_msg processed just below).
        port_msgs.each {|e| port_post(e[:end], e[:data]) }
        # A service worker → client message: deliver to the POSTING client's realm. The client id
        # encodes it — `client-<realm>` for a frame/window realm, 'client-window' for the main realm.
        # A `client.postMessage` to a controlled IFRAME must reach THAT frame's navigator.service-
        # Worker, not the top window (postmessage-to-client). `e[:handle]` is the SENDING worker, so
        # the client's message `source` is exact. A message to a DISCARDED frame realm is dropped
        # (matching a real browser — a message to a gone client is discarded, not misrouted to top).
        sw_msgs.each do |e|
          rid = sw_client_realm(e[:client])
          if (wh = sw_client_worker(e[:client]))
            # A worker CLIENT (a dedicated/shared worker the SW controls) — deliver to its own
            # isolate's `navigator.serviceWorker`, not to a browsing context, and not to the
            # worker's creator-facing `self.onmessage` (which is where a bare 'message' would land).
            (w = @workers[wh]) && w[:inbox] << {kind: 'sw_client_message', data: e[:data], handle: e[:handle]}
          elsif rid.nil?
            # An id naming nothing we know. Dropping matches a real browser (a message to a gone
            # client is discarded); delivering it to the main realm would MISROUTE it.
            nil
          elsif rid.zero?
            @runtime.call('__csim_swDeliverClientMessage', e[:data], e[:handle])
          elsif @runtime.frame_realm_alive?(rid)
            @runtime.realm_call(rid, '__csim_swDeliverClientMessage', e[:data], e[:handle])
          end
        end
        # A controlled fetch's respondWith result → resolve the pending client fetch in the
        # realm that issued it (fetch ids are per-realm, so realm_id disambiguates collisions).
        # A NEGATIVE realm_id names a WORKER client (-worker handle, __csimSWInterceptFetch):
        # its pendingFetch map lives in that worker's isolate, so the response rides its inbox.
        fetch_resps.each do |e|
          rid = e[:realm_id].to_i
          if rid.negative?
            @workers.dig(-rid, :inbox)&.push({kind: 'sw_fetch_response', fetch_id: e[:fetch_id], resp: e[:resp]})
          else
            @runtime.realm_call(rid, '__csim_swControllerFetchResponse', e[:fetch_id], e[:resp])
          end
        end
        # Streaming respondWith frames — deliver IN EMISSION ORDER (per fetch id: start → chunk* →
        # close/error) so the client reassembles the body ReadableStream correctly. The request's
        # @sw_fetch_pending was counted at fetch time and clears on the terminal frame.
        stream_frames.each do |e|
          fn = STREAM_FRAME_FNS[e[:kind]]
          @runtime.realm_call(e[:realm_id].to_i, fn, e[:fetch_id], e[:payload]) if fn
          # Track a stream's open span (head → terminal) per emitting worker, so worker_terminate
          # can release + error a body its worker died mid-stream.
          key = [e[:realm_id].to_i, e[:fetch_id].to_i]
          if e[:kind] == 'fr_start' then @sw_open_streams[e[:handle].to_i][key] = true
          else                           @sw_open_streams[e[:handle].to_i].delete(key)
          end
        end
        stream_terminals          = stream_frames.count {|e| e[:kind] == 'fr_close' || e[:kind] == 'fr_error' }
        @worker_init_lock.synchronize { @sw_fetch_pending = [0, @sw_fetch_pending - fetch_resps.size - stream_terminals].max }
        @worker_broadcast_pending = [0, @worker_broadcast_pending - acks.size].max
        @sw_message_pending       = [0, @sw_message_pending - swacks.size].max
        # A delivered swack/bcack refreshes the message-wait budget (drain_pending_message_reply), so
        # the next reply in a sequence waits afresh instead of inheriting a spent deadline. Done here,
        # at the single delivery point, so it fires no matter which drain path delivered the reply —
        # including hold_for_sw_fetch's outbox drain when a fetch co-pends (which would otherwise
        # strand an expired deadline and re-starve the next transferable reply under load).
        @sw_msg_wait_deadline     = nil if acks.size.positive? || swacks.size.positive?
        # `__error` postbacks don't correspond to a prior post, so bottom out at zero.
        @worker_in_flight = [0, @worker_in_flight - msgs.size].max
        # Mirror the release onto the answering worker's own tally, so what `reap_worker` hands
        # back when it dies is exactly what it still owes.
        msgs.each {|e| (w = @workers[e[:handle].to_i]) && (w[:in_flight] = [0, w[:in_flight].to_i - 1].max) }
        # A NESTED worker's messages (its Worker object lives in the PARENT worker's
        # isolate, not any realm) route through the parent's inbox; the rest go to the
        # main realm, which fans out to frame realms.
        nested, direct = msgs.partition {|e| @workers.dig(e[:handle].to_i, :parent_worker) }
        nested.group_by {|e| @workers.dig(e[:handle].to_i, :parent_worker) }.each do |pw, evs|
          @workers.dig(pw, :inbox)&.push({kind: 'nested_worker_msgs', events: evs})
        end
        # Each worker→parent message fires from its OWN task, its checkpoint before the next (HTML: the message event is
        # fired from a queued task) — the delivery's own, workers.js `deliverWorkerEvent`, the batch handed over at once.
        @runtime.call('__csim_deliverWorkerMessages', direct) unless direct.empty?
        events.size
      end

      def worker_timers_pending? = @workers.each_value.any? {|r| r[:timers_due] && !r[:stopping] }
      # The ms until the soonest timer any live worker has parked (-1 = none) — a page waiting on a worker's `setTimeout`
      # waits on it as on its own (the WPT drain's parked-timer progress): the worker's clock follows the window's, so the
      # window moving on is what brings it due.
      def worker_next_timer
        @workers.each_value.filter_map {|r| r[:next_timer] if r[:timers_due] && !r[:stopping] && r[:next_timer] }.min || -1.0
      end

      def worker_pending? = !@worker_outbox.empty? || !@worker_outbox_head.nil? || @worker_in_flight > 0 || @worker_broadcast_pending > 0 || @sw_message_pending > 0 || @sw_fetch_pending > 0 || @worker_init_lock.synchronize { @worker_initializing + @worker_busy } > 0

      # The subset of worker pendings whose outbox reply is CONTRACTUAL (bcack / swack /
      # fetch_response are posted under `ensure`, so they arrive even when the worker-side
      # handler raises). Safe for settle to block a bounded wait on — unlike @worker_in_flight
      # (a plain postMessage that a listen-only worker never answers) or @worker_initializing.
      def worker_reply_pending? = @worker_broadcast_pending > 0 || @sw_message_pending > 0 || @sw_fetch_pending > 0

      # The message/broadcast subset of `worker_reply_pending?` — a swack (client→SW postMessage /
      # cross-isolate port message) or a bcack (BroadcastChannel post). `run_event_loop_frame` waits
      # on these WITHOUT holding the clock (drain_pending_message_reply); the SW-fetch pending is held
      # separately (hold_for_sw_fetch), so it's deliberately excluded here.
      def worker_message_reply_pending? = @worker_broadcast_pending > 0 || @sw_message_pending > 0

      # Worker work that must keep a drain loop ALIVE (run_event_loop_frame's `async`),
      # invisible to the JS event-loop probe: a worker mid-boot (incl. the deferred
      # SW-served main-script fetch) or mid-handler, contractual replies owed, anything
      # already in the outbox, and — the race the counters alone miss — a delivered-but-
      # not-yet-processed message sitting in a live worker's INBOX (its thread needs a
      # GVL slice; between the delivery decrementing the pending counter and the worker
      # picking it up, every counter reads 0). Deliberately NOT the open-ended
      # @worker_in_flight: a listen-only worker holds that forever and would pin a drain
      # loop to its max-steps backstop.
      def worker_drive_pending?
        !@worker_outbox.empty? || !@worker_outbox_head.nil? ||
          worker_reply_pending? ||
          @worker_init_lock.synchronize { @worker_initializing + @worker_busy }.positive? ||
          @workers.to_a.any? {|_h, w| !w[:inbox].empty? && w[:thread]&.alive? }
      end

      # ── Cross-window messaging (window.open / opener / postMessage) ──
      # Each window is a separate Browser/VM/isolate, so a reference to another
      # window can only be a proxy that forwards through the Driver. These
      # forward host-fn calls (invoked from THIS window's VM) to the Driver,
      # which routes to the target window's Browser.

      # `window.open(url, name)` from JS — returns the new (or reused, by name)
      # window's handle, or nil. The URL is resolved against THIS document so a
      # relative `window.open('/x')` targets the right origin/path.
      # Its navigation's referrer the calling document — none for `noreferrer` (the features'), which implies `noopener`:
      # a window with no opener.
      def open_child_window(url, name, opener_realm_id = 0, about_base = nil, about_origin = nil, noopener = false, noreferrer = false)
        return nil unless @driver.respond_to?(:open_window_from_js)
        referrer, policy = noreferrer == true ? ['', 'no-referrer'] : realm_referrer_initiator(opener_realm_id.to_i)
        @driver.open_window_from_js(
          self,
          url.to_s,
          name.to_s,
          opener_realm_id.to_i,
          about_base.to_s,
          about_origin.to_s,
          noopener:        noopener == true || noreferrer == true,
          referrer:        referrer || '',
          referrer_policy: policy
        )
      end

      # A `target=_blank`/named link/area activation from frame or window realm `realm_id` in THIS browser opens a new
      # top-level auxiliary window (`open_hyperlink_window`). `opener` is the link's noopener's answer; the Driver
      # forces noopener for a cross-partition blob: target. `blob` is an optional click-time blob snapshot.
      def open_aux_from_realm(url, opener, blob, target, link_policy, realm_id)
        return unless @driver.respond_to?(:open_aux_window)
        open_hyperlink_window(
          resolve_document_url(url.to_s),
          target:      target,
          opener:      opener,
          link_policy: link_policy,
          blob:        blob.is_a?(Hash) ? blob : nil,
          realm_id:    realm_id.to_i
        )
      end

      # Open a SAME-ORIGIN auxiliary window as a realm in THIS browser's isolate
      # (shared heap) rather than a separate Browser/VM, returning the new realm's
      # context id for `window.open` to wrap in a NATIVE WindowProxy — so
      # `popup.document` is a real same-isolate Document and cross-window adoptNode
      # works (dom/nodes/remove-and-adopt-thcrash). Returns nil to fall back to the
      # separate-VM aux-window path. First stage: about:blank only (a non-blank
      # same-origin URL still takes the aux path until realm URL-loading lands).
      def open_window_realm(url, name: nil, opener_realm_id: 0, about_base: nil)
        return nil unless url.nil?
        consume_user_activation(opener_realm_id)
        @runtime.create_window_realm(
          '', '', 'text/html',
          window_name: name, opener_id: opener_realm_id, about_base: about_base
        )
      end

      # HTML "rules for choosing a navigable": a new top-level traversable made consumes the user activation of the
      # window that chose it, realm `realm_id`'s — the engine's (user_activation.rs), in every window of its page.
      def consume_user_activation(realm_id)
        @runtime.realm_call(realm_id.to_i, '__csimConsumeTransientActivation')
      rescue StandardError
        nil
      end

      # `targetWindow.postMessage(data, targetOrigin)` — route to the target window's
      # inbox, tagged with this window as the source. `target_origin` gates delivery
      # on the target side ('*' = any; a '/' was resolved to the sender's origin
      # JS-side); `sender_origin` becomes the delivered event.origin.
      def post_message_to_window(target_handle, data, target_origin, sender_origin)
        return unless @driver.respond_to?(:window_post_message)
        @driver.window_post_message(self, target_handle.to_s, data, target_origin.to_s, sender_origin.to_s)
      end

      def window_location_of(handle)   = @driver.respond_to?(:window_location)     ? @driver.window_location(handle.to_s).to_s     : ''
      # Cross-window property reads (a WindowProxy `win.foo` / `win.document.foo`):
      # route to the Driver, which reads a PRIMITIVE off the target window's VM.
      def window_get(handle, prop)     = (@driver.respond_to?(:window_read) ? @driver.window_read(handle.to_s, prop.to_s, doc: false) : nil)
      def window_doc_get(handle, prop) = (@driver.respond_to?(:window_read) ? @driver.window_read(handle.to_s, prop.to_s, doc: true)  : nil)
      # Cross-window remote-ref RPC — SOURCE side: forward a node/object proxy op to
      # the target window's Browser via the Driver.
      def window_ref_get(handle, id, prop)         = (@driver.respond_to?(:window_ref_get) ? @driver.window_ref_get(handle.to_s, id, prop.to_s) : nil)
      def window_ref_set(handle, id, prop, value)  = (@driver.window_ref_set(handle.to_s, id, prop.to_s, value) if @driver.respond_to?(:window_ref_set))
      def window_ref_call(handle, id, method, args) = (@driver.respond_to?(:window_ref_call) ? @driver.window_ref_call(handle.to_s, id, method.to_s, args) : nil)
      # TARGET side: execute the op against THIS window's VM (the Driver calls these
      # on the resolved target Browser).
      def remote_ref_get(id, prop)          = @runtime.call('__csimRemoteRefGet', id, prop.to_s)
      def remote_ref_set(id, prop, value)
        @runtime.call('__csimRemoteRefSet', id, prop.to_s, value)
        # A cross-isolate property set can queue a navigation in THIS (target)
        # window — `w.location.href = …` / `w.location = …`. Drain it (and any other
        # pending action it triggered) so the non-active window actions it now.
        drain_pending_after_remote_ref
        nil
      end
      def remote_ref_call(id, method, args)
        result = @runtime.call('__csimRemoteRefCall', id, method.to_s, args || [])
        # A cross-isolate call can queue a pending action in THIS (target) window —
        # `w.form.submit()` (form submit), `w.history.back()` (history traverse),
        # `w.location.assign()` (navigation). Drain them so the non-active window
        # actions them (they would otherwise wait for a Capybara action on it).
        drain_pending_after_remote_ref
        result
      end
      # Drain every deferred action a cross-isolate operation may have queued in this
      # window: form submission, plain navigation, same-document history traversal
      # (history.back/forward/go — restores the previous entry + fires load), and
      # child-frame navigation. Each consume is a no-op when nothing is pending.
      def drain_pending_after_remote_ref
        consume_pending_form_submit
        consume_pending_navigation
        consume_pending_history_traverse
        consume_pending_frame_nav
      end
      # Read a primitive property off THIS window's globalThis / document — called
      # by the Driver to serve another window's cross-window proxy read.
      def read_property(prop, doc: false)
        @runtime.call('__csimReadWindowProp', doc, prop.to_s)
      rescue StandardError
        nil
      end
      def set_window_location(handle, url) = (@driver.window_set_location(handle.to_s, url.to_s) if @driver.respond_to?(:window_set_location))
      # …to a javascript: URL `href`, by a document of origin `origin`: evaluated in that window's document.
      def run_window_javascript_url(handle, href, origin) = (@driver.window_run_javascript_url(handle.to_s, href.to_s, origin.to_s) if @driver.respond_to?(:window_run_javascript_url))
      # The target side: a javascript: URL another window's document of origin `origin` navigates this one to, evaluated
      # in this window's document where it is of that origin (url-parse.js `__csimRunJavascriptURLFrom`).
      def run_javascript_url_from(href, origin)
        @runtime.call('__csimRunJavascriptURLFrom', href.to_s, origin.to_s)
      end
      def window_history_go(handle, delta) = (@driver.respond_to?(:window_history_go) ? @driver.window_history_go(handle.to_s, delta.to_i) : false)
      def window_closed?(handle)       = @driver.respond_to?(:window_closed?)      ? @driver.window_closed?(handle.to_s)           : true
      def close_child_window(handle)   = (@driver.close_window(handle.to_s) if @driver.respond_to?(:close_window))
      def opener_handle                = @driver.respond_to?(:opener_handle_of)    ? @driver.opener_handle_of(self)                : nil
      # An AUXILIARY window's own `load` is fired by its OPENER, one task after the
      # document boots (platform-globals' `fireAuxLoadSoon`), so that a handler
      # either side registers right after `window.open()` — the child reporting back
      # through `window.opener`, the opener's own `w.onload` — is in place first.
      # Booting must not pre-empt that, hence the flag; the main window has nobody
      # to wait for and fires its own at the end of its boot.
      attr_accessor :defer_window_load

      # Fire the window `load` for a document that has finished booting — once the
      # navigation that produced it is over AND the driver is back between calls.
      # Both halves matter: a `load` handler may navigate (submit a form, point an
      # iframe somewhere), and those intents are stashed for
      # `drain_pending_navigation`, which applies them only when nothing else is on
      # the stack. Firing from inside `navigate` instead — even from its `ensure` —
      # left a frame navigation stranded (WPT's
      # event-global-is-still-set-when-coercing-beforeunload-result).
      #
      # The invariant the call sites buy: the load has fired by the time anything can
      # observe the new page.
      #   - `drain_pending_navigation`, which both the driver-initiated navigations
      #     (`visit` / `refresh` / history) and every page-initiated one end in;
      #   - `find_with_timer_fallback`, ahead of its timer gate — the backstop for a
      #     page that never ticks at all.
      # Returns whether this call fired (the drain chains on it).
      #
      # An AUXILIARY window's `load` is its opener's to fire (see
      # `defer_window_load`), so this only clears the marker there.
      private def flush_pending_window_load
        return unless @window_load_due
        # `load` waits for the document's subresources, and images are now fetched async —
        # deliver any that have landed and hold the event while some are still in flight. The
        # settle loop stays alive on `image_loads_pending?` (with a brief GVL-yielding park when
        # images are the only pending work) and the tick gates re-check every poll, so this is a
        # short deferral, never a stall. Matches a real browser: window `load` fires after every
        # <img> settles — one its server delayed too, which the realm holds on a page timer until
        # its virtual arrival (the timer keeps the settle loop going meanwhile) — and after every frame's
        # document fired its own, which the frame's images delay likewise (`__csimPageLoadDelayed`).
        deliver_image_loads
        return false if image_loads_pending? || (@runtime.call('__csimPageLoadDelayed') rescue false)

        @window_load_due = false
        # An AUXILIARY window's first load is its opener's to fire — ONE-SHOT, because
        # only that first document is opened through the opener; everything the window
        # navigates to afterwards is its own to announce.
        if @defer_window_load
          @defer_window_load = false
          return false
        end

        fire_own_window_load
        # A `load` handler's own navigation is stashed like any other page-initiated
        # one; apply it here rather than leaving the page half-way through what its
        # load asked for. Only what a HANDLER can queue — this window's own location,
        # and a frame it navigated or submitted. Not the whole drain: that one chains
        # back into this method (they recursed until the Ruby stack gave out on two
        # pages whose load handlers navigate to each other), and it also opens the
        # auxiliary windows a page asked for, which a `visit` must leave pending.
        consume_pending_frame_nav
        consume_pending_frame_submit
        consume_pending_page_submission
        true
      end

      # Fire an aux window's own window `load` (called by its opener, deferred).
      def fire_aux_window_load(handle)  = (@driver.fire_aux_window_load(handle.to_s) if @driver.respond_to?(:fire_aux_window_load))
      # A throwing `load` handler (or a frame build that throws while the document's
      # subresources are flushed) is the page's problem, not the driver's — but it has
      # to be VISIBLE, or the page simply looks half-wired with no explanation.
      # (…`delayable` false for an auxiliary window its opener fires the load of: one in the background, whose browser
      # neither steps nor delivers its images, fires it with nothing to wait for — HTML would have it wait for them)
      def fire_own_window_load(delayable: true)
        @runtime.call('__csimFireWindowLoad', delayable)
      rescue StandardError => e
        log_console('warn', "window load failed: #{e.class}: #{e.message}")
      end
      # The document-teardown pair (pagehide+unload), this window AND its nested
      # frames, parent-first — fired by the Driver before an explicitly-closed aux
      # window's VM is parked/disposed (redirect-keepalive "[new window][unload]").
      def fire_document_teardown        = (@runtime.call('__csimFireWindowUnloadDeep') rescue nil)

      # Queue a cross-window message for delivery into THIS window's VM (called
      # by the Driver on the target Browser). Delivered as a `message` event the
      # next time this window settles / ticks.
      def enqueue_window_message(data, target_origin, sender_origin, source_handle)
        @window_inbox << {'data' => data, 'targetOrigin' => target_origin.to_s, 'origin' => sender_origin.to_s,
                          'sourceHandle' => source_handle.to_s}
      end

      # Covers both cross-window postMessage AND BroadcastChannel — the two
      # cross-window event channels share these drain/pending hooks.
      def window_message_pending? = !@window_inbox.empty? || !@broadcast_inbox.empty? || !@storage_inbox.empty? || !@bc_queue.empty?

      # A BroadcastChannel message queued for delivery to this Browser's channels.
      # `source_realm_id` is the posting realm's context id within THIS isolate (0 =
      # main), or nil when the post came from ANOTHER isolate (the Driver's cross-
      # window fanout) — a nil source matches no local realm, so it reaches every one.
      def enqueue_broadcast(name, data, source_realm_id = nil, origin = nil)
        @broadcast_inbox << {'name' => name.to_s, 'data' => data, 'source' => source_realm_id, 'origin' => origin}
      end

      # A Storage change (setItem/removeItem/clear) in realm `source_realm_id`: fire a `storage`
      # event at every OTHER document of its storage key. Within this isolate that's the other realms
      # (main + frames — each lets another key's area go); localStorage ALSO spans separate
      # windows (the Driver's one shed), so fan the change out to them — sessionStorage is
      # per-browsing-context and never crosses windows.
      # (…`area` the area's storage key, as storage_areas.rs `storageAreaKey` writes it: a document of another lets the
      # event go)
      def storage_changed(kind, key, old, new, url, source_realm_id, area)
        enqueue_storage_event(kind, key, old, new, url, area, source_realm_id)
        @driver.storage_broadcast(self, kind, key, old, new, url, area) if kind == 'local' && @driver.respond_to?(:storage_broadcast)
        nil
      end

      # Queue a storage event for THIS window's documents. `source_realm_id` is the changing realm
      # within this isolate (skipped at delivery); nil (a cross-window fan-out) matches no realm, so
      # it reaches every one.
      # (…its targets the documents there are NOW, the source's skipped: a frame made after the change fires none for it —
      # HTML "broadcast": each Document whose storage area is the changed one, as the change is made)
      def enqueue_storage_event(kind, key, old, new, url, area, source_realm_id = nil)
        targets = [0, *@runtime.frame_realm_ids].reject {|id| id == source_realm_id }
        @storage_inbox << {'kind' => kind.to_s, 'key' => key, 'old' => old, 'new' => new, 'url' => url.to_s, 'area' => area.to_s, 'targets' => targets}
      end

      # Fire queued cross-window messages (postMessage, BroadcastChannel, `storage`) — each a task of its own: one per
      # host call, whose end runs the microtask checkpoint (kAuto), so a promise reaction that re-arms a listener between
      # two messages sees the second.
      def deliver_window_messages
        n = 0
        unless @window_inbox.empty?
          events = @window_inbox.slice!(0, @window_inbox.length)
          events.each {|event| @runtime.call('__csim_deliverWindowMessages', [event]) }
          n += events.size
        end
        unless @broadcast_inbox.empty?
          # A BroadcastChannel post from another window or a worker reaches this isolate's channels of its name and
          # origin — the posting realm's excepted — as one of this isolate's own does: one queue, in creation order
          # (HTML "postMessage" sorts its destinations by creation), which `deliver_broadcast_queue` drains below.
          @broadcast_inbox.slice!(0, @broadcast_inbox.length).each do |event|
            @runtime.call('__csimBcTargets', event['name'], event['origin'], event['source']).each_slice(2) do |rid, id|
              @bc_queue << {realm_id: rid.to_i, id: id, data: event['data'], origin_key: event['origin']}
            end
            n += 1
          end
        end
        unless @storage_inbox.empty?
          events = @storage_inbox.slice!(0, @storage_inbox.length)
          # The `storage` event fires at every document of the area's EXCEPT the one that changed it: the realms there
          # were as the change was made (`targets`), the source's skipped, those still alive.
          events.each do |event|
            event.delete('targets').each do |target_id|
              next unless target_id.zero? || @runtime.frame_realm_alive?(target_id)
              @runtime.realm_call(target_id, '__csim_deliverStorageEvents', event)
            end
          end
          n += events.size
        end
        # Drain the ordered BroadcastChannel queue LAST, so a `message`/`storage` handler above that
        # re-posts (multi-realm mode → bc_post) is picked up in this same pass.
        n += deliver_broadcast_queue unless @bc_queue.empty?
        n
      end

      # `BroadcastChannel.postMessage` in THIS window — fan out to every OTHER same-
      # origin browsing context's matching channels (same-realm delivery happens
      # in-VM). `source_realm_id` is the posting realm's context id. The cross-ISOLATE
      # fanout goes through the Driver; the same-ISOLATE fanout (main ↔ sibling realms,
      # sibling ↔ sibling) is queued here and delivered per-realm by
      # `deliver_window_messages`, which skips the posting realm.
      # Fan a BroadcastChannel post out to every OTHER same-origin browsing context. Called on the
      # MAIN thread — either directly from a main/frame-realm post (`source_realm_id` = the poster's
      # realm, `from_worker` nil), or from `deliver_worker_messages` for a WORKER-originated post
      # (`from_worker` = the posting worker's handle, `source_realm_id` nil).
      def broadcast_to_windows(name, data, source_realm_id = 0, origin = nil, from_worker: nil)
        broadcast_external(name, data, origin, from_worker: from_worker)
        # Same-isolate main + frame realms (LEGACY single-realm / worker-inbound path — the multi-realm
        # main-thread post goes through `bc_post`'s ordered queue instead). The poster already delivered
        # to itself in-VM, so this only reaches the OTHER realms — queue whenever one exists. A WORKER
        # post reaches realm 0 and every frame (a separate isolate delivered to none in-VM). A FRAME post
        # always reaches main realm 0 — even when the posting frame's own realm isn't yet recorded in
        # `frame_realms` (a BroadcastChannel posted SYNCHRONOUSLY during the frame's initial script runs
        # before the realm is registered, so `has_frames` can be false though a valid target — main —
        # exists). A MAIN post reaches the frames only when some are registered.
        has_frames = @runtime.frame_realm_ids.any?
        from_frame = !from_worker && !source_realm_id.nil? && source_realm_id != 0
        enqueue_broadcast(name, data, source_realm_id, origin) if has_frames || from_worker || from_frame
      end

      # Fan a BroadcastChannel post out beyond this isolate's main-thread realms: OTHER top-level windows
      # (separate isolates, via the Driver) and every live WORKER (separate isolate, via its thread-safe
      # inbox, except the posting worker). Shared by the legacy `broadcast_to_windows` and the ordered
      # `bc_post` — a same-isolate ordered post still reaches workers and other windows. `origin` here is
      # the SCOPING origin KEY (opaque token / tuple origin), which the worker + cross-window sides match on.
      def broadcast_external(name, data, origin, from_worker: nil)
        @driver.broadcast_channel(self, name.to_s, data, origin) if @driver.respond_to?(:broadcast_channel)
        # Skip a worker whose thread has already exited (self-close / termination in flight): it will
        # never drain its inbox, so pushing would leak. Counted in a dedicated pending tally so `settle`
        # waits until the worker acks the delivery (a `bcack`).
        @workers.each do |h, w|
          # A nil thread is a worker still SPAWNING (worker_spawn registers the record just
          # before Thread.new): its inbox exists and the thread will drain it — deliver.
          thread = w[:thread]
          next if h == from_worker || (thread && !thread.alive?)
          @worker_broadcast_pending += 1
          w[:inbox] << {kind: 'broadcast', name: name.to_s, data: data, origin: origin}
        end
      end

      # ── BroadcastChannel isolate-wide ordered delivery (multi-realm path) ──
      # Is another same-isolate realm (a frame / same-isolate window) live? Only then does a post use the
      # ordered queue; a single-realm page keeps the in-VM task path (zero behaviour change).
      def bc_siblings_exist? = @runtime.frame_realm_ids.any?

      # A main-thread BroadcastChannel post in multi-realm mode: one ordered delivery queued for each channel it reaches
      # — `targets`, [realm, id, …], the isolate's registry's snapshot at POST TIME in creation order, so a channel
      # made after the post never receives it and cross-realm targets interleave with same-realm ones by creation order
      # (broadcastchannel/ordering). Also fans out to workers + other windows. `origin` (serialized, e.g. "null") is
      # the MessageEvent.origin the same-isolate delivery exposes; `origin_key` (e.g. "opaque:…") the SCOPING token
      # workers / other windows match on.
      def bc_post(name, targets, origin_key, data, origin)
        targets.each_slice(2) do |rid, id|
          @bc_queue << {realm_id: rid.to_i, id: id, data: data, origin: origin}
        end
        broadcast_external(name.to_s, data, origin_key)
        nil
      end

      # Drain the ordered BroadcastChannel queue, delivering one message to one channel at a time in
      # creation order. A handler's synchronous re-post appends to `@bc_queue` (via bc_post), so the loop
      # keeps draining those in order too — reproducing the single global task queue the spec describes.
      # Bounded per call (like every drain loop here): a pathological mutual re-post between two realms
      # would otherwise spin forever holding the GVL. The cap leaves any remainder queued
      # (`window_message_pending?` keeps the loop live), so a runaway is bounded by the runner's
      # force-timeout across frames rather than hanging uninterruptibly in one.
      def deliver_broadcast_queue
        n = 0
        until @bc_queue.empty?
          break if n >= BROADCAST_DRAIN_CAP
          item = @bc_queue.shift
          # (…a channel closed since the post receives nothing: the realm's delivery asks the registry)
          next unless item[:realm_id].zero? || @runtime.frame_realm_alive?(item[:realm_id])
          # (…another window's or a worker's post its origin's KEY, which the receiving realm serializes)
          if item.key?(:origin_key)
            @runtime.realm_call(item[:realm_id], '__csim_bcDeliverInbound', item[:id], item[:data], item[:origin_key])
          else
            @runtime.realm_call(item[:realm_id], '__csim_bcDeliverOne', item[:id], item[:data], item[:origin])
          end
          n += 1
        end
        n
      end

      # ── Image loads ─────────────────────────────────────────────────
      #
      # Fetch + decode an `<img>` resource to an RGBA bitmap for the drawImage / createPattern surface (the decode is
      # csim_native's, memoized by content: see `@@image_cache`). Returns {'width','height','refId'} — the pixels ride
      # the transfer registry, a FRESH stash per call, since `fetchTransfer` consumes the entry — or nil when the
      # resource can't be fetched or decoded (the caller fires `error`). A scheme with no host-side reader returns
      # {'unsupported' => true}, which the caller takes for broken too — a blob: one it never asks for, reading the blob
      # from the VM's own store.
      # `cors` (a `crossorigin` <img>) fetches under CORS: a cross-origin response without a
      # matching Access-Control-Allow-Origin fails the load. `credentials` is 'include' for
      # crossorigin="use-credentials", 'same-origin' (uncredentialed cross-origin) otherwise.
      def load_image(url, cors = false, credentials = 'same-origin', realm: nil, referrer_policy: nil, opaque: false)
        key = resolve_against_current(url.to_s)
        return nil unless key.is_a?(String)
        Thread.current[:csim_image_meta] = nil
        entry = cached_image(key, cors, credentials, client: load_client(realm, key, referrer_policy: referrer_policy, opaque: opaque))
        return {'unsupported' => true} if entry == :unsupported
        return undecodable_image_result unless entry
        image_payload(entry, image_tainted?(key, cors), Thread.current[:csim_image_meta])
      end

      # Start an async <img> load: resolve + capture the requesting document identity on THIS
      # (the main) thread, then fetch + decode on a background one. Returns the request id the
      # JS side files its pending element under, or -1 when the URL can't resolve (the caller
      # falls back to the synchronous path). The heavy call chain is exactly `load_image`'s —
      # same cache, same CORS enforcement, same taint verdict — just off-thread.
      def image_load_start(url, cors = false, credentials = 'same-origin', realm: nil, referrer_policy: nil, opaque: false)
        key = resolve_against_current(url.to_s)
        return -1 unless key.is_a?(String)
        client = load_client(realm, key, referrer_policy: referrer_policy, opaque: opaque)
        id = nil
        @image_load_lock.synchronize do
          id = (@image_load_seq += 1)
          @image_load_results[id] = :pending
          @image_load_pending += 1
          # SINGLE-FLIGHT per request identity: N <img>s sharing a src (an avatar column) must
          # not race N identical Rack requests + decodes where the sync path did one fetch and
          # N−1 cache hits. Followers just register their id on the in-flight group; the one
          # thread finalizes every member with the shared result.
          flight = [key, cors, credentials, client]
          if (group = @image_load_flights[flight])
            group << id
            next
          end
          group = [id]
          @image_load_flights[flight] = group
          spawn_app_request_thread do
            r = nil
            begin
              r = begin
                image_load_result(key, cors, credentials, client)
              rescue StandardError
                nil
              end
            ensure
              # `ensure`, exactly like keepalive's thread: an escaping non-StandardError (or a
              # kill) must not strand the slots as :pending forever — that would hold every tick
              # gate and the window-load deferral open for the rest of the session. `reset!`
              # discards the whole slot table, and the `== :pending` guard keeps a finishing
              # orphan from resurrecting its entry afterwards. The pending counter holds until
              # DELIVERY — "pending" means in-flight OR finished-but-undelivered, or the tick
              # gate closes before the result lands. Every follower of this flight shares the
              # one result. Finalize OUR group only: after a reset cleared the table, the same
              # key can belong to the NEXT session's flight — deleting that would hand its
              # followers this stale result and orphan its own.
              @image_load_lock.synchronize do
                @image_load_flights.delete(flight) if @image_load_flights[flight].equal?(group)
                group.each do |m|
                  @image_load_results[m] = {result: r} if @image_load_results[m] == :pending
                end
              end
            end
          end
        end
        id
      end

      # The thread-side body: everything except the transfer stash (engine-affine, done at
      # delivery on the main thread). Result mirrors `load_image`'s shapes with the raw entry.
      private def image_load_result(key, cors, credentials, client)
        Thread.current[:csim_image_meta] = nil
        entry = cached_image(key, cors, credentials, client: client)
        return {'unsupported' => true} if entry == :unsupported
        return undecodable_image_result unless entry
        { entry: entry, tainted: origin_tainted?(key, cors, client_url: client.url), meta: Thread.current[:csim_image_meta] }
      end
      # A response that arrived but is no image: the element is broken, the resource was still
      # fetched — its Resource Timing entry carries the real status and size.
      private def undecodable_image_result
        meta = Thread.current[:csim_image_meta]
        meta ? {'broken' => true, 'meta' => meta} : nil
      end

      def image_loads_pending?
        @image_load_pending.positive?
      end

      # Hand every finished async image load to its realm: the one that began it, which the engine
      # keeps for the request (`__csimImageFetchRealm`); an id no realm has (its page died) is
      # dropped. Returns the number delivered.
      def deliver_image_loads
        finished = nil
        @image_load_lock.synchronize do
          return 0 if @image_load_results.empty?
          finished = @image_load_results.reject {|_, v| v == :pending }
          finished.each_key {|k| @image_load_results.delete(k) }
          @image_load_pending -= finished.size
        end
        return 0 if finished.empty?
        n = 0
        finished.each do |id, slot|
          payload = image_result_payload(slot[:result])
          consumed = begin
            rid = @runtime.call('__csimImageFetchRealm', id).to_i
            if rid.zero? then @runtime.call('__csimApplyAsyncImage', id, payload) == true
            elsif rid.positive? then @runtime.realm_call(rid, '__csimApplyAsyncImage', id, payload) == true
            else false
            end
          rescue StandardError
            false
          end
          # Nobody consumed it (its page is gone): reclaim the stashed bitmap, or every
          # navigated-away image on an image-heavy run pins its RGBA buffer until teardown.
          if !consumed && payload.is_a?(Hash)
            transfer_buffer_fetch(payload['refId']) if payload['refId']
            transfer_buffer_fetch(payload['refIdP3']) if payload['refIdP3']
          end
          n += 1
        end
        n
      end

      # Shape a thread result into what `_applyImageResult` reads, stashing the bitmap for
      # transfer HERE, on the main thread, only for results that actually deliver.
      private def image_result_payload(r)
        return nil if r.nil?
        return r unless r.is_a?(Hash) && r.key?(:entry)
        image_payload(r[:entry], r[:tainted], r[:meta])
      end

      # What an `<img>` applies of a decoded entry (`_applyImageResult`): its size, natural size and colour space, its
      # bitmaps stashed for transfer — none for an image with no pixels, which loads with nothing to draw — and its
      # taint verdict and Resource Timing figures.
      private def image_payload(entry, tainted, meta)
        out = {'width' => entry['width'], 'height' => entry['height'], 'natural' => entry['natural'], 'orientation' => entry['orientation'], 'tainted' => tainted, 'encoded' => entry['encoded'], 'meta' => meta}
        return out.merge('noPixels' => true) if entry['noPixels']
        out['colorSpace'] = entry['colorSpace']
        out['refId']      = transfer_buffer_stash(entry['bytes'])
        out['refIdP3']    = transfer_buffer_stash(entry['bytesP3']) if entry['bytesP3']
        out
      end

      # Whether a successfully-loaded image taints a canvas it's drawn into: its bytes came
      # cross-origin without CORS approval — i.e. a no-cors http(s) load from a different origin
      # than the document. A CORS load that reached here passed the Access-Control check (so it's
      # origin-clean), and same-origin / data: images are always clean. An opaque-origin document
      # (data:/srcdoc/sandboxed — nil origin) is cross-origin to every http(s) image, so any such
      # image taints it.
      private def image_tainted?(key, cors)
        origin_tainted?(key, cors)
      end

      # Whether a successfully-loaded media resource (image / video frame) taints
      # a canvas it's drawn into: its bytes came cross-origin without CORS
      # approval. The verdict compares against the fetching CLIENT's document
      # origin when one is threaded (a frame's own document), else the top
      # document — the same http(s) gate rack_fetch's client identity uses (an
      # opaque-origin about:blank / javascript: realm falls back to the top).
      private def origin_tainted?(url, cors, client_url: nil)
        return false if cors || !url.to_s.match?(%r{\Ahttps?://}i)
        res = url_origin(url.to_s)
        return false unless res
        base = client_url.to_s.match?(%r{\Ahttps?://}i) ? client_url : @current_url
        doc  = url_origin(base)
        doc.nil? || doc != res
      end

      # The decoded image for `key`: fetch the bytes (every load — the HTTP cache decides
      # whether that is a network round trip), then decode, memoized by the bytes' digest.
      # :unsupported for a scheme we can't fetch host-side; nil on fetch/decode failure. A
      # CORS load's success is origin-dependent (a response's ACAO may allow one origin and
      # not another) — fetching per load is what keeps the verdict the requesting document's
      # own; only the origin-free decode result is shared.
      private def cached_image(key, cors = false, credentials = 'same-origin', client: load_client(nil, key))
        bytes = image_source_bytes(key, cors, credentials, client: client)
        return bytes if bytes == :unsupported
        return nil unless bytes
        cache_key = Digest::SHA256.digest(bytes)
        cached = @@image_cache_lock.synchronize { @@image_cache[cache_key] }
        return cached if cached
        # The decode (csim_native's image_decode.rs, off the GVL): {'width', 'height', 'natural', 'colorSpace',
        # 'bytes'[, 'bytesP3']} — `natural` the natural size the layout sizes an `<img>` from ([width, height, view box
        # width, view box height], NaN where it has none), `colorSpace` ('srgb' | 'display-p3') the space the bytes are
        # in, for drawImage to convert from, `bytesP3` a wide-gamut (CMYK / Adobe RGB) source's Display P3 rendering
        # beside the sRGB one — with 'noPixels' and no bytes for an image that loads with nothing to draw (one with no
        # area, an SVG `width="0"`; one corrupt past the header that gave its size); or nil for no image (the caller
        # fires `error`).
        entry = Native.decode_image(bytes, 0, 0)
        return nil unless entry
        entry['encoded'] = bytes.bytesize   # the resource's size for its Resource Timing entry
        @@image_cache_lock.synchronize do
          @@image_cache.clear if @@image_cache.size >= IMAGE_CACHE_MAX
          @@image_cache[cache_key] = entry
        end
        entry
      end

      # Raw (encoded) bytes for an image URL: `data:` decoded inline, http(s) via a
      # binary-safe fetch (`body_raw`; the text body would mangle non-ASCII image
      # bytes). A `cors` load threads 'cors' mode + credentials into the
      # fetch, so rack_fetch's Access-Control enforcement rejects (→ nil) a cross-origin
      # response with no matching ACAO. :unsupported for a scheme with no host-side reader,
      # nil for a missing / failed / CORS-rejected / empty resource.
      private def image_source_bytes(key, cors = false, credentials = 'same-origin', client: load_client(nil, key))
        if key.start_with?('data:')
          bytes = decode_data_url_body(key)
          bytes.empty? ? nil : bytes
        elsif key.match?(%r{\Ahttps?://}i)
          # The requesting DOCUMENT identity is pinned to what it was when the load started —
          # on the async path this runs on a background thread, and a concurrent navigation
          # must not swing the CORS / SameSite / Referer verdicts to a document that never
          # issued this request.
          result = rack_fetch('GET', key, '', {}, 'follow', cors ? 'cors' : nil, credentials: credentials, client_url: client.url,
                              referrer: client.referrer, referrer_policy: client.referrer_policy, body_raw: true,
                              cookie_cross_site: client.cookie_cross_site)
          # What the image's Resource Timing entry reports of the response — its content type,
          # whether it was redirected to, its status and size — read back on this thread right
          # after; a 404 is a response too, the entry keeping its status.
          if result
            Thread.current[:csim_image_meta] = {
              'contentType' => result['headers'].find {|k, _| k.to_s.casecmp?('content-type') }&.last,
              'tao'         => result['tao'],
              'redirected'  => result['redirected'] == true,
              'status'      => result['status'].to_i,
              'encoded'     => result['encoded'].to_i,
              'delayMs'     => server_delay_ms_of(result['headers'])
            }
          end
          # (…its status no part of whether it is an image: HTML "update the image data" — an image an error response
          # carries is shown, Chrome's too; a body that decodes to none is a broken one)
          return nil unless resource_loaded?(result)
          bytes = result['body_raw'].to_s
          bytes.empty? ? nil : bytes
        else
          :unsupported
        end
      end

      # The fontconfig file backing a CSS family + weight/style, for NATIVE text metrics: csim_native parses it with
      # fontations (skrifa) — advances, line metrics, x-height. nil when unresolved. Memoised (hit AND miss) so it
      # asks fontconfig once.
      def font_file(family, weight_style = nil)
        key = "#{family} #{weight_style}"
        @font_table_lock.synchronize do
          return @font_files[key] if @font_files.key?(key)
        end
        path = font_file_for_family(family.to_s, weight_style.to_s)
        @font_table_lock.synchronize { @font_files[key] = path }
        path
      end

      # fontconfig maps a CSS family to a font file (`fc_match`) — once per family per
      # session (the caller memoises hits AND misses).
      # A browser's default for the proportional generics, NOT fontconfig's: Chrome
      # asks for Arial / Times New Roman (which fontconfig substitutes with the
      # metric-compatible Liberation faces), while a bare `fc-match sans-serif` here
      # answers Noto Sans — measurably different advances (16 "i"s at 16px: Chrome
      # 56.9, Liberation Sans 56.9, Noto Sans 66.0). `monospace` is deliberately NOT
      # mapped: Chrome's fixed-width default resolves through fontconfig, and the
      # measured line boxes match fontconfig's answer, not Courier New's.
      GENERIC_FAMILY_DEFAULTS = {
        'sans-serif'    => 'Arial',
        'system-ui'     => 'Arial',
        'ui-sans-serif' => 'Arial',

        'serif'         => 'Times New Roman',
        'ui-serif'      => 'Times New Roman',

        'cursive'       => 'Comic Sans MS',
        'fantasy'       => 'Impact'
      }.freeze

      # The GENERIC families, which always resolve (fontconfig's job) and end a stack.
      GENERIC_FAMILIES = %w[
        sans-serif serif monospace cursive fantasy system-ui
        ui-sans-serif ui-serif ui-monospace ui-rounded math emoji fangsong
      ].freeze

      # Blink retries a family it could not resolve under an ALTERNATE NAME — three
      # pairs, both ways (`font_cache.cc`'s `AlternateFamilyName`). It is why
      # `font-family: Helvetica` still renders in Arial's face on a Linux box that has
      # neither: Chrome asks again for Arial, which fontconfig aliases to Liberation
      # Sans. Without it, Helvetica fell through to the fallback serif.
      ALTERNATE_FAMILIES = {
        'arial'           => 'Helvetica',
        'helvetica'       => 'Arial',

        'courier'         => 'Courier New',
        'courier new'     => 'Courier',

        'times'           => 'Times New Roman',
        'times new roman' => 'Times'
      }.freeze

      # Resolve a CSS `font-family` STACK the way a browser does: try each family in
      # order (and its alternate name), take the first that resolves, and let the
      # generic at the end catch what's left.
      private def font_file_for_family(stack, weight_style)
        families = split_font_stack(stack)
        families << 'sans-serif' if families.empty?
        families.each do |fam|
          key = fam.downcase
          # A generic always resolves, to whatever fontconfig answers for the family a
          # browser asks on its behalf (Chrome's default sans IS Arial).
          if GENERIC_FAMILIES.include?(key)
            file, = fc_match(GENERIC_FAMILY_DEFAULTS[key] || fam, weight_style)
            return file if file

            next
          end
          file = resolved_family_file(fam, weight_style) ||
                 resolved_family_file(ALTERNATE_FAMILIES[key], weight_style)
          return file if file
        end
        # Nothing in the stack resolved and it named no generic: a browser falls back
        # to its STANDARD font (Chrome's is Times New Roman), not to nothing.
        fc_match('Times New Roman', weight_style).first
      end

      # The face fontconfig resolves `family` to — or nil when it has no rule for that
      # name and merely answered with its fallback.
      #
      # The distinction is the whole problem: a fontconfig match NEVER fails, so a name it
      # SUBSTITUTED looks exactly like a name it ignored. Chrome tells them apart the
      # way Skia does — it expands the request through `FcConfigSubstitute`, drops the
      # WEAKLY bound families (the generic fallback chain every request ends with), and
      # accepts the match only if it is one of what's left. That set is the
      # metric-alias list: `Arial` expands to Arial / Arimo / Liberation Sans / Albany,
      # `Times New Roman` to Tinos / Liberation Serif, while `Georgia`, `Segoe UI` and
      # `Inter` expand to nothing but themselves — so a substituted family is accepted
      # and an unknown one is not, which is what Chrome measures in each case.
      #
      # fontconfig prefers a strong family over a weak one, so the single match
      # already answers a strong family whenever one is installed: no iteration needed.
      private def resolved_family_file(family, weight_style)
        return nil if family.nil?

        file, matched = fc_match(family, weight_style)
        return nil unless file
        return file if font_family_matches?(family, matched)

        strong = fc_strong_families(family)
        strong&.any? {|fam| font_family_matches?(fam, matched) } ? file : nil
      end

      # The families `family` expands to under this machine's fontconfig rules, keeping only the STRONG bindings (what
      # `fc-pattern -c` marks `(s)`; csim_native's fontconfig.rs asks the library). Memoised.
      private def fc_strong_families(family)
        @fc_strong_lock.synchronize do
          return @fc_strong_families[family] if @fc_strong_families.key?(family)
        end
        list = Native.font_strong_families(fc_escape(family))
        @fc_strong_lock.synchronize { @fc_strong_families[family] = list }
        list
      end

      # `font-family: "Helvetica Neue", Arial, sans-serif` → the family names, unquoted — parsed as CSS, a comma inside a
      # quoted one no separator (font_faces.rs `family_list`).
      private def split_font_stack(stack)
        Native.font_family_list(stack.to_s)
      end

      # fontconfig treats `-`, `:` and `,` as pattern syntax — a family called
      # "Helvetica-Light" would parse as family "Helvetica" at a size. Escape them.
      private def fc_escape(pattern)
        pattern.gsub(/([-:,\\])/) { "\\#{Regexp.last_match(1)}" }
      end

      # The face fontconfig matches `pattern` (at `weight_style`) to, as fc-match answers it: [the face — its file, and
      # its index where the file is a collection (csim_native's `font::face_name`) — the face's family names], [nil, nil]
      # for none.
      private def fc_match(pattern, weight_style)
        escaped = fc_escape(pattern)
        escaped += ":#{weight_style}" unless weight_style.to_s.empty?
        Native.font_match(escaped) || [nil, nil]
      end

      # The matched face's own family list holds more than one name for a face that declares aliases ("Noto Sans",
      # "Noto Sans Regular") — so a match is "the requested name is one of them", case-insensitively. It does NOT carry
      # the names fontconfig substituted THROUGH to get here (asking for Arial answers "Liberation Sans", never
      # "Arial"); that case is the substitution test in `font_file_for_family`.
      private def font_family_matches?(want, matched)
        w = want.to_s.downcase
        Array(matched).any? {|m| m.strip.downcase == w }
      end

      # Resolve an @font-face src URL to an on-disk font file native text reads, fetching
      # the bytes through the Rack app (binary-safe) once and caching the temp path for
      # the process. Returns nil when the fetch fails.
      def font_file_for(url)
        font_file_and_meta_for(url).first
      end

      # `[path, meta]`: the face's file on disk (nil when it could not be fetched or read) and
      # the facts of the fetch that brought it (`resource_timing_meta`); a cross-visit cache hit
      # reports the same facts as served from the cache (Chrome files a cached font with
      # `transferSize` 0).
      def font_file_and_meta_for(url)
        key = resolve_against_current(url.to_s)
        return [nil, nil] unless key.is_a?(String)
        @@font_file_lock.synchronize do
          if @@font_file_cache.key?(key)
            path, meta = @@font_file_cache[key]
            return [path, meta && meta.merge('cached' => 'cache')]
          end
        end
        if (failed = (@font_file_failed ||= {})[key])
          return [nil, failed]
        end
        Thread.current[:csim_font_meta] = nil
        path = build_font_file(key)
        meta = Thread.current[:csim_font_meta]
        if path
          @@font_file_lock.synchronize { @@font_file_cache[key] = [path, meta] }
        else
          @font_file_failed[key] = meta          # remembered for THIS session only
        end
        [path, meta]
      end

      private def build_font_file(key)
        bytes = font_source_bytes(key)
        return nil unless bytes && !bytes.empty?
        bytes = Native.font_sfnt(bytes)
        return nil unless bytes
        require 'tempfile'
        # Keep the Tempfile object alive for the process so its file isn't reaped while
        # fontconfig may still read it; the cache holds the path.
        file = Tempfile.new(['csim-font', File.extname(key)[0, 5]])
        file.binmode
        file.write(bytes)
        file.flush
        # Pin the handle for the whole process: the path is cached in the CLASS-level
        # @@font_file_cache and outlives the per-visit Browser that first built it, so
        # the Tempfile must not be finalized (and its file unlinked) with that instance.
        @@font_file_lock.synchronize { @@font_files << file }
        file.path
      end

      # Raw font bytes for a URL: `data:` inline, http(s) via a binary-safe Rack fetch
      # (`body_raw`: a text body would mangle the font's non-ASCII).
      private def font_source_bytes(key)
        if key.start_with?('data:')
          bytes = decode_data_url_body(key)
          bytes.empty? ? nil : bytes
        elsif key.match?(%r{\Ahttps?://}i)
          # A font is a CORS fetch (CSS Fonts 4 §4.9.1): a cross-origin face without
          # `Access-Control-Allow-Origin` fails, as in Chrome.
          result = rack_fetch('GET', key, '', {}, 'follow', 'cors', credentials: 'same-origin',
                              client_url: @current_url, referrer: @current_url, body_raw: true)
          # The fetch's facts for the font's Resource Timing entry (read back by the caller
          # on this thread), a 404 included.
          Thread.current[:csim_font_meta] = result && resource_timing_meta(result)
          # (…its status no part of whether it is an image: HTML "update the image data" — an image an error response
          # carries is shown, Chrome's too; a body that decodes to none is a broken one)
          return nil unless resource_loaded?(result)
          bytes = result['body_raw'].to_s
          bytes.empty? ? nil : bytes
        end
      end

      # A downloaded face (an `@font-face` src), fetched through the HTTP layer like any resource: its decoded SFNT
      # file (nil when the bytes are no font the decoder reads — a 404, a broken file), with the fetch's facts for its
      # Resource Timing entry and `ok`, whether bytes arrived (a data: face has no fetch facts; an unreadable
      # container still loads, measured with the fallback family).
      def web_font_fetch(url)
        file, meta = font_file_and_meta_for(url)
        {'path' => file, 'meta' => meta, 'ok' => !file.nil? || (meta && meta['status'].to_i.between?(200, 399)) == true}
      end

      # A `local(<name>)` `@font-face` source: the file of the font INSTALLED under that name, or nil when this machine
      # has no such font (fontconfig SUBSTITUTES silently, so `resolved_family_file` — the same exact-match test the
      # family stack uses — is what tells a real installed face from a fallback). A face whose every `local()` misses
      # and that has no readable `url()` then fails, as a browser rejects a UA font load it cannot satisfy.
      def local_font_file(name, weight_style = '')
        key = "#{name} #{weight_style}"
        @@font_file_lock.synchronize do
          return @@local_font_cache[key] if @@local_font_cache.key?(key)
        end
        file = resolved_family_file(name.to_s, weight_style.to_s)
        @@font_file_lock.synchronize { @@local_font_cache[key] = file }
        file
      end

      # A face's own bytes (a `FontFace` built from a buffer, a `blob:` src): decoded like a downloaded file to an SFNT
      # file. `ok` is whether the bytes are a recognised font container at all; `path` nil where it decodes to nothing.
      # Content-addressed so identical bytes reuse one temp file, not one per call.
      FONT_MAGIC = ["\x00\x01\x00\x00".b, 'OTTO'.b, 'true'.b, 'ttcf'.b, 'wOFF'.b, 'wOF2'.b].freeze
      def font_file_from_bytes(bytes)
        bytes = bytes.to_s.b
        ok    = bytes.bytesize >= 4 && FONT_MAGIC.include?(bytes[0, 4])
        return {'path' => nil, 'ok' => ok} unless ok
        sfnt = Native.font_sfnt(bytes)
        return {'path' => nil, 'ok' => true} if sfnt.nil? || sfnt.bytesize < 12
        key  = "bytes:#{Digest::SHA256.hexdigest(sfnt)}"
        path = @@font_file_lock.synchronize { @@font_file_cache[key]&.first }
        unless path
          require 'tempfile'
          file = Tempfile.new(['csim-font', '.bin'])
          file.binmode
          file.write(sfnt)
          file.flush
          @@font_file_lock.synchronize { @@font_files << file; @@font_file_cache[key] = [file.path, nil] }
          path = file.path
        end
        {'path' => path, 'ok' => true}
      end

      def reset_workers
        # Ask first, and stop the JS half in the same pass: the `:terminate` message is only read
        # BETWEEN messages, so a worker inside a long JS call would otherwise not see it until that
        # call finished — and `Thread#kill` cannot reach it there either (see `stop_worker_js`).
        # The kill stays as the last resort, for a worker that is neither in JS nor at its inbox.
        doomed = @workers.values.dup
        doomed.each do |w|
          w[:inbox] << :terminate
          stop_worker_js(w)
        end
        doomed.each {|w| stop_worker_wait(w) }
        # Reap the killed threads before the boundary's own DB work runs: Thread#kill
        # is NOT deferred by ActiveRecord's `handle_interrupt(Exception => :never)`
        # (only an `Object => :never` mask would defer it), so a kill can land
        # mid-DB-call inside a worker's rack_fetch and leave the app's shared PG
        # socket mid-protocol — the same wedge class drain_app_request_threads
        # exists for. Bounded the same way; a worker past the budget is warned, not
        # waited for forever.
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + APP_REQUEST_DRAIN_BUDGET_S
        doomed.each do |w|
          next if (t = w[:thread]).nil?
          joined = begin
            t.join([deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC), 0].max)
          rescue StandardError
            t # join re-raised the thread's terminating error — it is dead, i.e. reaped
          end
          warn "[capybara-simulated] worker thread still running at the session boundary (#{t.inspect})" unless joined
        end
        @workers.clear
        @sw_pending_uninstalls = []
        @sw_steps_queued       = Set.new
        @sw_step_waits         = {}
        @sw_jobs_queued        = Set.new
        @sw_job_evals          = {}
        @sw_jobs_behind        = {}
        @worker_outbox.clear
        @worker_outbox_head       = nil
        @worker_in_flight         = 0
        @worker_broadcast_pending = 0
        @sw_message_pending       = 0
        @sw_fetch_pending         = 0
        @sw_open_streams.clear
        @sw_fetch_wait_deadline   = nil
        @sw_msg_wait_deadline     = nil
        Native.sw_clear(@sw_partition)
        reset_sw_race_state
        # Keepalive threads are never KILLED — delivering the beacon is their
        # contract — but they no longer outlive the session boundary either:
        # dispose/reset! drain them (join, so the beacon still lands) via
        # drain_app_request_threads before this runs. The per-id size map makes a
        # late release/finalize generation-safe against these clears regardless.
        @keepalive_lock.synchronize do
          @keepalive_results.clear
          @keepalive_inflight_sizes.clear
          @keepalive_inflight = 0
        end
        @sw_navs_deferred    = false
        @sw_scope_meta       = {}
        @sw_pending_claims   = []
        Native.sw_forget_clients(@sw_partition)
        @sw_direct_replies   = {}
        # Adopted-id aliases go with the client registry. @sw_resulting_seq is NOT reset:
        # id uniqueness across the whole process is the invariant the aliases rely on.
        @sw_client_aliases   = {}
        @sw_realm_aliases    = {}
        @focused_realm_id    = nil
        @port_ends           = {}
        @sw_nav_outbox.clear
        @transfer_buffer_lock.synchronize {
          @transfer_buffers.clear
          @transfer_buffer_seq = 0
        }
      end

      # The number of this window's blob URL registry (blob_registry.rs), which its contexts enter and resolve their
      # URLs in.
      attr_reader :blob_window

      # A blob URL a context of this window made (its entry the context entered in the registry): its STORAGE
      # PARTITION (this window's top-level site) recorded beside it (blob_registry.rs `set_site`), so another window
      # resolves or revokes it only from the same partition (blob URL partitioning) — the window that made it found by
      # its registry, its bytes read back from wherever they live (its isolate).
      def blob_register(url)
        Native.blob_registry_set_site(@blob_window, url.to_s, blob_partition_site)
        nil
      end

      # The SITE (scheme + registrable domain, the engine's: `registrable_site`) of this window's top-level document —
      # what storage partitioning keys a blob URL on: its creator's top-level site, so a same-origin iframe embedded in a
      # cross-site top-level context is a DIFFERENT partition and can't reach the blob. A blob: document derives from its
      # inner origin; data:/about: (no host) '' (an opaque origin, never same-partition with a real one).
      def blob_partition_site
        registrable_site(@current_url) || ''
      end

      # The blob a `blob:` URL names now — wherever the window that made it is (its partition's) — as `{bytes:, type:}`, or
      # nil for none: what a navigation to it that began with none loads.
      def blob_snapshot(url)
        @driver.respond_to?(:blob_bytes_for) ? @driver.blob_bytes_for(url, self) : read_blob_for_window(url)
      end

      # Read a blob URL's bytes + content type from THIS window's VM (its local
      # blob store) — the Driver uses it to load a blob: document into a fresh aux
      # window opened by this window. Returns {bytes:, type:} or nil.
      def read_blob_for_window(url)
        host_blob(@runtime.call('__csimReadBlobForWindow', url.to_s))
      rescue StandardError
        nil
      end
      # A blob the page hands the host, `{'bytes' => …, 'type' => …}`, as `{bytes:, type:}` — nil for none.
      def host_blob(blob) = blob.is_a?(Hash) && blob['bytes'] ? {bytes: blob['bytes'], type: blob['type'].to_s} : nil

      # Load a blob: document (bytes from the opener) as THIS window's top-level
      # document — for `window.open(blobURL)` / a blob: aux-window navigation,
      # where the blob isn't rack-navigable and lives in the opener's isolate.
      # (…`flushed` where its caller flushed the outgoing page already: `navigate`, before the history entry it records)
      def boot_blob_document(url, bytes, content_type, flushed: false)
        # Before the URL below lands (see `flush_outgoing_page_init`).
        flush_outgoing_page_init if @timers_active && !flushed
        @current_url = url.to_s
        ct = content_type.to_s.empty? ? 'text/html' : content_type.to_s
        # Blob string parts are UTF-8-encoded; when the Blob type carries no
        # charset, decode the document as UTF-8 (not the windows-1252 HTML locale
        # default, which is an HTTP concept that doesn't apply to in-memory blobs —
        # matches the iframe blob: path's decodeBlobBody). A charset in the Blob
        # type (url-charset) is preserved so it can override <meta charset>.
        ct = "#{ct};charset=utf-8" unless ct.downcase.include?('charset')
        record_response(200, {'content-type' => ct})
        bytes = bytes.to_s.b
        # Make the blob URL fetchable from the document we're about to load — a blob:
        # document that fetches itself (or a media `src` first-party load) snapshots
        # the bytes SYNCHRONOUSLY at fetch() time, which runs DURING boot below, so the
        # bytes are entered in this window's registry as its new page begins — after the
        # outgoing one's URLs and copies are let go of, before its document loads. No
        # partition entry — the blob keeps its original storage partition; this only makes it
        # first-party-fetchable in the window it was navigated into; a copy, which the next
        # page to begin here lets go of.
        boot_response_into_ctx(bytes) { Native.blob_registry_copy(@blob_window, url.to_s, bytes, content_type.to_s) }
        # Adopt into the in-VM store too, so the document's blob resolves as the blob it is.
        @runtime.call('__csimAdoptBlobBytes', url.to_s, bytes, content_type.to_s) rescue nil
      end

      # …and a blob: URL loaded as THIS window's top-level document that no store resolves (revoked before it was taken):
      # a network error — its error document committed at the URL, as Chrome's failed load is — never a path on the
      # app's server.
      def fail_blob_document(url) = commit_error_document(url.to_s)

      # A user-initiated `URL.revokeObjectURL`. Storage-partitioned + cross-isolate:
      # a cross-partition revoke does nothing (a same-origin but cross-top-level-site
      # context can't revoke the blob — cross-partition.https: the site its maker in a
      # window of this session recorded, blob_registry.rs `partition`), and a
      # same-partition one invalidates the blob in the MAKER's isolate too so every
      # window stops resolving it (the blob may have been created in another window).
      # (Context-teardown revokes go through revoke_owned_blobs, not here.)
      def blob_unregister(url)
        maker, site = Native.blob_registry_partition(@blob_window, url.to_s)
        return nil if site && site != blob_partition_site
        @driver.drop_blob_in_window(maker, url.to_s, self) if maker && maker != @blob_window && @driver.respond_to?(:drop_blob_in_window)
        drop_local_blob(url)
        nil
      end

      # Forget a blob URL in THIS isolate: its entry in the window's registry and
      # its in-VM store entry. Called for a local revoke and, via
      # the Driver, when another same-partition window revokes a blob this isolate
      # created. The registry removal is the AUTHORITATIVE invalidation
      # (resolveBlobBytes gates on it cross-realm); the in-VM `__csimDropBlob` is a
      # same-thread V8 call, so it's skipped on a worker thread — a worker's
      # `revokeObjectURL` forwards here on the WORKER thread, and calling a
      # thread-confined isolate from a non-owning thread SEGVs (V8 isolates
      # are thread-bound). The stale in-VM entry is harmless: resolveBlobBytes returns
      # null once the registry marker is gone.
      def drop_local_blob(url)
        Native.blob_registry_delete(@blob_window, url.to_s)
        return if Thread.current[:csim_worker_handle]   # worker thread: the registry removal above is enough
        @runtime.call('__csimDropBlob', url.to_s) rescue nil
      end

      # Revoke every blob URL owned by a context that's going away (its blob URL
      # store is part of the global being torn down).
      def revoke_owned_blobs(key)
        Native.blob_registry_revoke_owner(@blob_window, key)
        nil
      end
      # Keys are normalized with `.to_i` (blob.js enters a realm's URLs as "r:<id>", a worker's as "w:<handle>") so a
      # marshalled Float/String id still matches.
      def revoke_worker_blobs(handle) = revoke_owned_blobs("w:#{handle.to_i}")
      def revoke_realm_blobs(realm_id) = revoke_owned_blobs("r:#{realm_id.to_i}")
      # The copies the last blob: document booted here held let go of — but a URL a realm of this window
      # has since made its own, which its owner's revocation governs.
      def forget_blob_copies = Native.blob_registry_forget_copies(@blob_window)

      # ── postMessage transferable-buffer registry ───────────────────
      #
      # Large Uint8Array / ArrayBuffer payloads cross isolates by ID;
      # rusty_racer marshals typed arrays as ASCII-8BIT Strings so no
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

      # JS reports each zero-copy transfer token it mints (`RustyRacer.transferOut`)
      # so we can release any that go unimported. Callable from a worker thread.
      def transfer_token_issued(token)
        t = token.to_i
        @transfer_tokens_lock.synchronize { @transfer_tokens << t } if t > 0
        nil
      end

      # Release every outstanding transfer token's backing store. The transfer
      # registry is process-wide (it bridges isolates) and survives isolate
      # teardown, so an unimported token would leak across the whole run; drop
      # them on `reset!` via the (still-live) main context — `transferDrop` is
      # idempotent, so dropping already-imported tokens is a harmless no-op.
      def drop_pending_transfers
        toks = @transfer_tokens_lock.synchronize { ts = @transfer_tokens; @transfer_tokens = []; ts }
        return if toks.empty?
        @runtime.call('__csimTransferDropAll', toks) rescue nil
      end

      # Fetch a media resource (http / relative URL) and return its bytes, so a `<video
      # src>` pointing at a served file decodes the same way a blob: / data: source does.
      # Returns {'bytes', 'tainted'}, or nil when the fetch fails.
      def video_bytes(url, cors = false, credentials = 'same-origin', client_url = nil)
        # A `crossorigin` element runs the CORS check (an ACAO refusal fails the
        # load); a plain one is a no-cors fetch whose cross-origin bytes TAINT a
        # canvas they're drawn into — the exact <img> model (image_tainted?), with
        # the fetching CLIENT's document (a frame's own, not the top window's) as
        # the origin the verdict compares against.
        result = rack_fetch('GET', url, '', {}, 'follow', cors ? 'cors' : nil, credentials: credentials, client_url: client_url, body_raw: true)
        return nil unless resource_loaded?(result) && result['status'].to_i < 400
        bytes = result['body_raw'].to_s
        return nil if bytes.empty?
        {'bytes' => bytes, 'tainted' => origin_tainted?(url, cors, client_url: client_url)}
      end

      def webauthn = (@webauthn ||= WebauthnState.new)

      # Worker thread entry. Builds an isolate via `V8Runtime.build_worker`,
      # evaluates the worker script, then loops draining microtasks + timers +
      # inbox until `:terminate` lands or an exception propagates.
      private def run_worker(handle, url, body, inbox, outbox, record: nil, name: '', shared: false, service: false, creator_key: nil, sw_scope: nil, controller: 0, sw_script: nil, creator_client: nil, module_worker: false, sw_uvc: nil, sw_imports_map: nil, sw_prev_active: nil)
        # Release the spawn-time `@worker_initializing` count exactly once, however
        # this method exits (normal start, `self.close()`, or an exception), so
        # worker_pending? doesn't stay stuck true forever.
        initializing = true
        release_init = lambda do
          next unless initializing
          initializing = false
          @worker_init_lock.synchronize { @worker_initializing -= 1 }
        end
        # True while THIS thread holds a `@worker_busy` increment for a message it's
        # mid-handling; balanced in the `ensure` so an exception between the bump and
        # the matching decrement can't strand the counter (which would pin
        # `worker_pending?` true forever).
        busy_held = false
        # Tag this thread so blob URLs created by the worker's script are owned by
        # this handle and revoked on terminate (see blob_register / revoke_worker_blobs).
        Thread.current[:csim_worker_handle] = handle
        # …and with its record, which its fetches are judged by (worker_cross_site?): a navigation removes the registry's
        # entry without waiting for the thread, and a fetch still in flight is the worker's all the same.
        Thread.current[:csim_worker_record] = record
        rt = nil
        # The worker's clock follows the window's (one agent cluster's time): a tick with a timer pending advances it a
        # poll interval, or as far as the window's clock has moved since the last tick, whichever is more — a window
        # fast-forwarding to its next timer moves the worker's timers with it, where a worker on its own clock waited
        # out a multi-second `setTimeout` in real time while the page's harness timed out. Asked EVERY tick, so what
        # the window moved while the worker had no timer is spent then, not owed to the next timer it sets; and a
        # window's clock that went back (a navigation's page starts its own at 0) moved nothing.
        window_was = nil
        # (`floor`: the least it advances — a poll interval once a tick, so a worker whose window's clock stands still
        # still runs)
        worker_clock_step = lambda do |floor|
          window = @runtime ? @runtime.clock : 0.0
          moved  = window_was && window > window_was ? window - window_was : 0.0
          window_was = window
          [floor, moved].max
        end
        # "Has the session boundary asked this worker to stop?" — the Ruby-side half of that ask
        # (`stop_worker_js` sets the flag; `terminate` handles the JS already in flight). Read
        # where the tick could otherwise commit to another long call.
        stopping = -> { !record.nil? && record[:stopping] }
        # The worker's timers, run before the tick's message — a poll interval at least — and again after one, as far as
        # the window has moved since: the message's own timers, and what its handler left in the microtask queue,
        # progress in the same tick. The stop is asked right before the drain: THIS is the call that can run for seconds — its 50 ms budget is
        # checked BETWEEN timer callbacks, and one callback is as long as it is — so a stop that arrived while we were
        # deciding must not buy another one. What lands once the call is already running is `terminate`'s job; between
        # the two, the window is a few instructions wide.
        run_worker_timers = lambda do |floor|
          step = worker_clock_step.call(floor)
          next if stopping.call || (rt.call('__nextTimerDelay').to_f < 0 && !(Native.agent_notices_pending(@session_partition) && rt.call('__csimAgentsPending')))

          rt.drain_microtasks
          rt.drain_timers(step)
        end
        # A nil body with `sw_script` set is the DEFERRED case — the script is fetched
        # through the controlling SW below, after the isolate exists.
        raise "worker script not found: #{url}" unless body || sw_script
        # The worker SCRIPT is text; the Rack-fetched body arrives
        # BINARY-tagged (see `RuntimeShared.utf8_text`).
        body = RuntimeShared.utf8_text(body) if body
        post_back = ->(data) { outbox << {handle: handle, kind: 'message', data: data.to_s} }
        # A worker's BroadcastChannel post rides the same thread-safe outbox; the main thread fans
        # it out to the main + frame realms + OTHER workers (see deliver_worker_messages).
        broadcast_out = ->(name, data, origin) { outbox << {handle: handle, kind: 'broadcast', name: name.to_s, data: data, origin: origin} }
        # Service-worker → main-thread signals ride the outbox (delivered by deliver_worker_messages):
        # client.postMessage, clients.claim (→ set the client's controller), and a controlled fetch's
        # respondWith result. `sw_has_fetch` is snapshotted after the SW script's initial run (the
        # spec records fetch-handler presence at install time) so a claim can tell the client
        # whether intercepting is worth the cross-isolate round-trip at all.
        sw_has_fetch = false
        # Streams a race-network leg already beat — their remaining frames are
        # swallowed by the fetch_stream hook (this worker's thread only).
        sw_race_dropped_streams = {}
        # (…and its origin, whose clients it sees)
        sw_origin = url_origin(url).to_s
        sw_hooks = {
          # The worker's WebSockets: opened and written from this thread, their events into this worker's inbox.
          ws_open:        ->(ws_url, protocols) { ws_open(ws_url, protocols, WsWorker.new(handle, inbox, url)) },
          ws_close:       ->(id, code, reason) { ws_close(id, code, reason, hold: false) },
          # A script exception the worker's global left unhandled, for its Worker's `error` (workers.js).
          report_error:   ->(message, filename, lineno, colno) { outbox << {handle: handle, kind: '__scripterror', message: message.to_s, filename: filename.to_s, lineno: lineno.to_i, colno: colno.to_i} },
          post_to_client: ->(client_id, data) { outbox << {handle: handle, kind: 'sw_client_msg', client: client_id, data: data.to_s} },
          # WindowClient.navigate() — the browser owns the act, and the worker is waiting on the
          # OUTCOME (final URL / cross-origin / refusal), so the reply comes back on this worker's
          # inbox keyed by nav_id.
          navigate_client: ->(client_id, url, nav_id) { outbox << {handle: handle, kind: 'sw_client_navigate', client: client_id, url: url.to_s, nav_id: nav_id.to_i} },
          claim:          ->                  { outbox << {handle: handle, kind: 'sw_claim', has_fetch: sw_has_fetch} },
          # Its Clients: the registry's clients of its origin as it sees them (sw_registry.rs — behind its lock, so read
          # from this worker's own thread), `[id, url, type, frame type, controlled by it, focused]` each.
          client_record:  ->(client_id) { Native.sw_client(@sw_partition, handle, sw_origin, client_id.to_s)&.to_a },
          match_clients:  ->(include_uncontrolled, type) { Native.sw_match_clients(@sw_partition, handle, sw_origin, !!include_uncontrolled, type.to_s).map(&:to_a) },
          # skipWaiting() — record the flag HERE, on the worker's own thread, before the
          # broadcast is even queued: the activation gate (sw_may_activate?) reads it from the
          # worker record, so a broadcast consumed before the registering realm built its
          # worker objects can no longer lose it (the skip-waiting.https TIMEOUT flake). The
          # outbox event's only remaining job is resuming a parked activation.
          skip_waiting:   ->                  {
            (wk = @workers[handle]) && wk[:skip_waiting] = true
            outbox << {handle: handle, kind: 'sw_skip_waiting'}
          },
          # self.registration.unregister() — an Unregister job, scheduled on the main thread
          # (process_worker_unregister); the reply rides this worker's inbox as 'unregister_result'.
          unregister:     ->                  { outbox << {handle: handle, kind: 'sw_unregister'} },
          # A race-network-and-fetch-handler route matched: run the network leg on a
          # host thread concurrently with the fetch-event dispatch the worker is
          # about to (possibly synchronously-blocking) run. See sw_race_network.
          race_network:   ->(fetch_id, realm_id, url2, method) { sw_race_network(handle, fetch_id, realm_id, url2, method) },
          # The install handler registered Static Routing API rules (addRoutes) — the
          # rules themselves live in the worker isolate (evaluated at its dispatch
          # point); the host records only their EXISTENCE, which keeps a router SW
          # with no fetch handler dispatchable (the has_fetch gates all consult it).
          # Recorded on the worker's own thread at post time, like skip_waiting.
          router:         ->                  { (wk = @workers[handle]) && wk[:has_router_rules] = true },
          # An unsettled ExtendableMessageEvent.waitUntil EXTENDS this worker's lifetime:
          # while any are pending an installed successor keeps waiting (activation.https),
          # and the 0-transition re-runs try-activate to release it.
          extended:       ->(n) {
            (wk = @workers[handle]) && wk[:extended] = n.to_i.positive?
            outbox << {handle: handle, kind: 'sw_try_activate'} unless n.to_i.positive?
          },
          fetch_respond:  ->(fetch_id, resp, realm_id) { sw_deliver_fetch_response(handle, fetch_id.to_i, resp.to_s, outbox, realm_id.to_i) },
          # A streaming respondWith frame (start / chunk / close / error) for a controlled client's
          # fetch — rides the outbox in emission order so the client realm reassembles the body
          # stream incrementally (deliver_worker_messages). The request's @sw_fetch_pending stays up
          # for the whole stream and clears on the terminal (close / error) frame.
          # A RACED fetch's STREAMING respondWith runs the same modeled-delay
          # decision the single-shot path does (sw_race_take_network_win) — at
          # the stream head. A network win delivers the pre-fetched leg through
          # the normal single-shot path and drops the losing stream WHOLE: head,
          # chunks, and terminal — an outboxed terminal would decrement a
          # pending this stream never owned. `sw_race_dropped_streams` is
          # touched only on THIS worker's thread (the hook's caller), so it
          # needs no lock.
          fetch_stream:   ->(fetch_id, kind, payload, realm_id) {
            fid = fetch_id.to_i
            key = [realm_id.to_i, fid]
            if fid.positive?
              if kind.to_s == 'start'
                if (win = sw_race_take_network_win(realm_id, fid))
                  sw_race_dropped_streams[key] = true
                  sw_deliver_fetch_response(handle, fid, win, outbox, realm_id.to_i)
                  next
                end
              elsif sw_race_dropped_streams[key]
                sw_race_dropped_streams.delete(key) if %w[close error].include?(kind.to_s)
                next
              end
            end
            outbox << {handle: handle, kind: "fr_#{kind}", fetch_id: fid, payload: payload.to_s, realm_id: realm_id.to_i}
          },
          # Cross-isolate MessagePort channels: the ends this worker takes and gives up, and what its ports post, ride
          # the outbox (deliver_worker_messages relays them).
          port_here:      ->(end_id)       { outbox << {handle: handle, kind: 'port_here', end: end_id.to_s} },
          port_gone:      ->(end_id, held) { outbox << {handle: handle, kind: 'port_gone', end: end_id.to_s, held: Array(held).map(&:to_s)} },
          port_closed:    ->(end_id)       { outbox << {handle: handle, kind: 'port_closed', end: end_id.to_s} },
          port_redeliver: ->(end_id, data) { outbox << {handle: handle, kind: 'port_redeliver', end: end_id.to_s, data: data.to_s} },
          port_post:      ->(end_id, data) { outbox << {handle: handle, kind: 'port_msg', end: end_id.to_s, data: data.to_s} }
        }
        worker_kind = if service then 'service' elsif shared then 'shared' else 'dedicated' end
        rt          = V8Runtime.build_worker(self, post_back, broadcast_out, sw_hooks, kind: worker_kind, name: name)
        # Hand the runtime to the session boundary (`stop_worker_js`) the moment it exists.
        record[:rt_lock].synchronize { record[:rt] = rt } if record
        # A worker isolate loads the same snapshot as the main realm, so its `console.*`
        # is a no-op until `traceActive` is set (console.js). The main realm turns it on
        # from `CSIM_CONSOLE_STDERR`; without this a worker's console — and anything routed
        # through it, e.g. an Emscripten `printErr` — is silently dropped during debugging.
        rt.call('__csimSetTraceActive', true) if CONSOLE_STDERR
        # This worker's handle — the JS keys cross-isolate MessagePort channel ids on it so they
        # never collide with another isolate's (see __csim_installWorkerScope's allocator).
        rt.eval_void("globalThis.__csimWorkerHandle = #{handle.to_i};")
        # …and the token its realm's agent of the engine's registries is made with (agents.rs), whose locks and
        # connections go as it is reaped — not only once its isolate is gone, which a terminated one may outlive.
        if record
          record[:agent_owner] = Native.agent_owner_new
          rt.eval_void("globalThis.__csimAgentOwner = #{record[:agent_owner]};")
        end
        # A dedicated / shared worker is a service-worker CLIENT of its origin, and the host
        # registry already records it as 'client-worker-<handle>' (sw_note_worker_client). Seed
        # the SAME id as this isolate's client identity (clientId() prefers __csimClientId), so
        # a worker's own `ServiceWorker.postMessage` names itself correctly as the source and an
        # SW's `client.postMessage` reply routes back to THIS isolate (sw_client_worker) instead
        # of falling back to 'client-window' → the main realm. (Subresource interception FROM a
        # worker isolate would also want this id, but no controller is ever installed into a
        # worker isolate today — that's the controlled-worker follow-up, not this line.)
        # A SERVICE worker is not a client.
        rt.eval_void("globalThis.__csimClientId = #{JSON.generate(sw_worker_client_id(handle))};") unless service
        # A MODULE worker ({type: 'module'}): the flag drives the classic-only surface
        # (importScripts throws a TypeError); its script evaluates as a real module graph
        # below (eval_module_graph).
        rt.eval_void('globalThis.__csimWorkerModule = true;') if module_worker
        # THIS worker is a controlled CLIENT: install its controller into the isolate BEFORE
        # the script runs, so `navigator.serviceWorker.controller` exists and its fetch()/XHR
        # route through the SW (__csimSWControllerHandle > 0) — the same pre-load wiring a
        # controlled frame realm gets (create_frame_realm).
        if !service && controller.to_i.positive? && (cw = @workers[controller.to_i])
          rt.call('__csim_swSetControllerDirect', controller.to_i, sw_interception_worthy?(cw), cw[:script_url].to_s, sw_serving.key(controller.to_i).to_s)
        end
        # Set the worker's `self.location.href` so webpack /
        # rollup public-path derivation + `new URL(rel, import.meta.url)`
        # resolve chunks against the worker's own origin rather than
        # the snapshot-time `http://placeholder/`.
        rt.eval_void("globalThis.__csimUpdateLocation(#{JSON.generate(url.to_s)});")
        # A worker's BroadcastChannel origin KEY (its agent-cluster identity). A blob: worker
        # INHERITS the creating context's origin (the blob URL carries no real origin of its own);
        # a data: worker gets a FRESH opaque origin, unique per worker, so it never cross-talks with
        # its creator or a sibling data: worker. An http(s) worker leaves this unset — the JS derives
        # its key from `location.origin` (the script's own origin, same as the creator when
        # same-origin). See `__csimBcOriginKey`.
        worker_origin_key =
          if url.to_s.start_with?('blob:')
            creator_key
          elsif url.to_s.start_with?('data:')
            "opaque:worker#{handle}"
          end
        rt.eval_void("globalThis.__dom.setOriginKey(#{JSON.generate(worker_origin_key)});") if worker_origin_key
        # A service worker runs in a ServiceWorkerGlobalScope: adjust the worker scope
        # (no blob-URL minting; SW lifecycle stubs) BEFORE its script runs. The
        # registration SCOPE rides in first — `self.registration.scope` must be the
        # registration's scope URL, not the script URL (two registrations sharing one
        # script are distinct registrations; anything keyed on the scope, e.g. a
        # per-registration cache name, must not collide).
        if service
          rt.eval_void("globalThis.__csimSwScope = #{JSON.generate(sw_scope.to_s)};") unless sw_scope.to_s.empty?
          # The registration's updateViaCache mode — importScripts' cache decision
          # ('none' revalidates every import; 'imports'/'all' read the HTTP cache).
          rt.eval_void("globalThis.__csimSwUvc = #{JSON.generate(sw_uvc)};") if sw_uvc
          # The Update probe's import responses — this version's script resource map
          # (importScripts consume them one-shot instead of re-fetching).
          rt.eval_void("globalThis.__csimSwImportMap = #{JSON.generate(sw_imports_map)};") if sw_imports_map
          # The registration's active version at spawn — `self.registration.active`
          # while THIS version installs (registration-attribute's newer worker).
          rt.eval_void("globalThis.__csimSwPrevActive = #{JSON.generate(sw_prev_active)};") if sw_prev_active
          rt.eval_void('__csim_installServiceWorkerScope();')
        end
        # A DEFERRED main script (worker_spawn found a controlling, fetch-handling SW for the
        # script URL): fetch it through the SW redirect chain NOW, on this worker's own thread
        # (worker_main_script_fetch) — per-hop interception, network fall-back included.
        if body.nil? && sw_script
          fetched = worker_main_script_fetch(sw_script, url, handle, shared: shared, creator_client: creator_client)
          raise "worker script blocked: #{url}" if fetched == :error
          raise "worker script not found: #{url}" unless fetched

          body = RuntimeShared.utf8_text(fetched[:body])
          # Across a redirect chain the worker's identity moves: its location becomes the
          # FINAL RESPONSE URL (the base importScripts()/fetch() resolve against), and its
          # controller the SW that saw the LAST fetch event — which can differ from the
          # spawn-time scope match on the REQUEST URL (worker-interception-redirect: a
          # scope1 request network-redirected to scope2 stays controlled by sw1; an
          # sw1-redirect re-intercepted by sw2 hands control to sw2).
          final_url  = fetched[:url].to_s
          final_ctrl = fetched[:controller].to_i
          if final_url != url || final_ctrl != controller.to_i
            if final_url != url
              url = final_url
              (w = @workers[handle]) && w[:url] = url
              rt.eval_void("globalThis.__csimUpdateLocation(#{JSON.generate(url)});")
            end
            if final_ctrl != controller.to_i
              controller = final_ctrl
              if controller.positive? && (cw = @workers[controller])
                rt.call('__csim_swSetControllerDirect', controller, sw_interception_worthy?(cw), cw[:script_url].to_s, sw_serving.key(controller).to_s)
              end
            end
            # Refresh the registry's client record (URL + controller) — called from this worker's
            # thread, as sw_note_worker_controller is.
            sw_note_worker_client(handle, url, shared, controller)
          end
        end
        if service
          # A SERVICE worker's registration is GATED on its script actually evaluating
          # ("Run Service Worker": an importScripts that 404s, a top-level throw, a
          # parse error — each fails the Register/Update job). Catch the failure, post the
          # outcome (the job settles on it — sw_job_evaluated), and exit with no
          # lifecycle: no version was installed.
          begin
            if module_worker
              # A `{type: 'module'}` service worker evaluates as a REAL module graph:
              # static imports are fetched here, on this worker's own thread, and each
              # failure (404, non-JS MIME, unresolvable bare specifier) fails the whole
              # evaluation — exactly the classic importScripts contract, spec'd for
              # modules at fetch time. Each import is recorded (sw_note_import) so the
              # Update byte-check probes the graph, and the Update PROBE's own recorded
              # responses are consumed first (the fetch-once script resource map — a
              # changed import the probe saw must be the bytes this version runs,
              # update-bytecheck's time-varying imports).
              sw_import_fetch = lambda do |abs|
                rec  = sw_imports_map && sw_imports_map[abs]
                if rec
                  raise "module import failed: #{abs} (#{rec['status']})" unless (200..299).cover?(rec['status'].to_i)

                  ct   = (rec['headers'] || {}).find {|k, _| k.to_s.casecmp('content-type').zero? }&.last
                  body2 = rec['body'].to_s
                else
                  r = rack_fetch('GET', abs, '', {}, 'follow', cache_mode: sw_uvc == 'none' ? 'no-cache' : 'default')
                  raise "module import failed: #{abs}" unless resource_loaded?(r) && (200..299).cover?(r['status'].to_i)

                  ct   = (r['headers'] || {}).find {|k, _| k.to_s.casecmp('content-type').zero? }&.last
                  body2 = r['body'].to_s
                end
                # Strict (unlike classic importScripts' allHostsLocal-gated check, the
                # Mastodon-Tesseract concession): Chrome enforces JS MIME for module
                # scripts unconditionally, and service workers only exist under the
                # universal-server context anyway (register() rejects elsewhere), so
                # the app-pragmatic concern that motivated the classic gate can't arise.
                raise "module import has an unsupported MIME type: #{abs}" unless js_mime_type?(ct)

                sw_note_import(handle, abs, body2)
                body2
              end
              rt.eval_module_graph(body, url, sw_import_fetch)
            else
              rt.eval_void(body)
            end
          rescue StandardError => e
            outbox << {handle: handle, kind: 'sw_eval', ok: false, msg: "#{e.class}: #{e.message}"}
            return
          end
          outbox << {handle: handle, kind: 'sw_eval', ok: true}
        else
          module_fetch = worker_module_fetch(handle, controller.to_i, url.to_s)
          rt.accept_dynamic_imports(url.to_s, module_fetch)
          if module_worker
            run_worker_module(rt, body, url.to_s, handle, outbox, module_fetch)
          else
            run_worker_script(rt, body, url.to_s)
          end
        end
        rt.drain_microtasks
        # Drive the service worker's lifecycle: fire `install`, then `activate`, each phase
        # ADVANCING ONLY WHEN ITS `waitUntil` PROMISES HAVE ALL SETTLED — a promise parked on
        # a client message (extendable-event-waituntil's SYN/ACK, fetch-waits-for-activate's
        # 'ACTIVATE') settles from a later inbox dispatch, so the settle check runs at the
        # bottom of the poll loop too, not just here at boot. Each settled phase posts a
        # marker the client-side timeline parks its observable state on:
        #   {phase:'install', ok:} — ok:false (a rejected waitUntil) fails the version: the
        #     client marks it redundant and never activates it (Install "installFailed").
        #   {phase:'activated'} — the activate handler's side effects (a clients.claim(),
        #     cache warm-up) are already in the outbox AHEAD of this marker (FIFO), so a page
        #     reading `navigator.serviceWorker.controller` right after `wait_for_state(...,
        #     'activated')` sees the claim (activation.https setup); a rejected activate
        #     waitUntil still activates (the spec ignores activate failure for state).
        sw_check_phase = nil
        if service
          sw_has_fetch = !!rt.call('__csim_swHasFetchListener')
          # Publish the fetch-handler snapshot + script URL on the worker record so a NAVIGATION
          # into this SW's scope can decide (Ruby-side) whether routing through it is worthwhile,
          # and a freshly-built frame client can mint a `controller` naming this script.
          if (w = @workers[handle])
            w[:has_fetch]  = sw_has_fetch
            w[:script_url] = url.to_s
          end
          sw_fire_phase = lambda do |phase|
            rt.eval_void("globalThis.__csim_swFireLifecycleEvent(#{JSON.generate(phase)});")
            # Drain microtasks AND timers: a `waitUntil` promise may settle off a
            # setTimeout (e.g. a delayed cache warm-up), so advance the worker clock too.
            rt.drain_microtasks
            rt.drain_timers
          end
          # 'install' pending → 'activate' pending → nil (done, or install failed — a
          # failed version fires no activate; the client terminates this worker).
          sw_phase_pending = 'install'
          sw_check_phase = lambda do
            while sw_phase_pending && (t = rt.call('__csim_swPhaseTake'))
              if t['phase'] == 'install'
                ok = t['ok'] != false
                outbox << {handle: handle, kind: 'sw_phase', phase: 'install', ok: ok}
                sw_phase_pending = nil unless ok
                next unless ok

                sw_phase_pending = 'activate'
                sw_fire_phase.call('activate')
              else
                outbox << {handle: handle, kind: 'sw_phase', phase: 'activated'}
                sw_phase_pending = nil
              end
            end
            # Engine complete (or failed) — drop the closure so the poll loop's per-tick
            # check costs nothing for the rest of this worker's life.
            sw_check_phase = nil unless sw_phase_pending
          end
          sw_fire_phase.call('install')
          # The common no-waitUntil path settles both phases right here at boot, inside the
          # @worker_initializing hold — both markers reach the outbox before release_init.
          sw_check_phase.call
        end
        # Fire any timer the initial script parked BEFORE releasing the init hold — the
        # same gated drain the poll loop runs per tick. `fetch()` defers its body to a
        # setTimeout(0), so a fetch() issued by the initial script is,
        # at this point, ONLY a due timer: once the init hold drops, nothing pending-
        # visible remains until the first poll tick (50 ms away), and a runner that
        # force-timeouts on idle kills the test inside that blind window
        # (worker-interception-redirect's last case). Draining here runs the fetch's
        # dispatch on this thread while `@worker_initializing` still covers it, so the
        # follow-on pending (@sw_fetch_pending / outbox) is counted before the release.
        if !stopping.call && rt.call('__nextTimerDelay').to_f >= 0
          rt.drain_microtasks
          rt.drain_timers
        end
        # Initial script has run (and any immediate postMessage is in the outbox).
        release_init.call
        # A worker that called `self.close()` in its top-level script stops here —
        # the script ran (and may have posted), but no further messages are pulled.
        unless rt.call('__csimWorkerClosedRead')
          loop do
            msg = pop_with_timeout(inbox, WORKER_POLL_INTERVAL)
            break if msg == :terminate
            # …and the same answer from the boundary, which cannot wait for this queue.
            break if stopping.call
            # Drive the worker's OWN event loop each tick, BEFORE the message: the time the window has moved since the
            # last tick passes for the timers already set — those due fire ahead of the message, the tasks queued
            # before it — and a timer the message sets starts from there, not owed what went by before it was set.
            # An AUTONOMOUS loop (the dispatcher executor-worker's receive→fetch→setTimeout retry, which has no inbox
            # message) progresses by it alone; worker http fetch is setTimeout(0)+__rackFetch, resolved on this
            # thread by the drain. Gated on a PENDING timer (any, not just due-now — the clock must advance to fire a
            # future randomDelay) so an idle message-driven worker with no timers stays lazy. Host CALLS, not string
            # `eval`, keep the per-tick cost off the V8 compile path (rule 3).
            # (…a poll interval at least on a quiet tick, the one real time passed in: a tick of a message, however many
            # come, moves it only as far as the window has moved)
            run_worker_timers.call(msg.nil? ? WORKER_POLL_INTERVAL * 1000 : 0)
            # A main-side BroadcastChannel post to this worker arrives as a {kind:'broadcast'} hash;
            # deliver it to the worker's channels (the receiver's own origin gate drops cross-origin).
            # A plain string is a postMessage to the worker.
            if msg.is_a?(Hash) && msg[:kind] == 'broadcast'
              # Ack so the main thread releases the broadcast-pending it counted for this delivery
              # (a listen-only worker never posts back — the ack is the only signal it processed
              # it). Under `ensure`: the ack is CONTRACTUAL (settle's bounded wait relies on it —
              # see worker_reply_pending?), so a raising channel handler must not leak it.
              # (…each channel's delivery a task of the worker's: run, a handler's synchronous postback with it, BEFORE the
              # ack — the outbox is FIFO, so the reply precedes the ack settle waits on)
              begin
                rt.call('__csim_deliverBroadcasts', [{'name' => msg[:name], 'data' => msg[:data], 'origin' => msg[:origin]}])
                run_worker_timers.call(0)
              ensure
                outbox << {handle: handle, kind: 'bcack'}
              end
            elsif msg.is_a?(Hash) && msg[:kind] == 'sw_message'
              # A client → service-worker postMessage: dispatch a `message` event with source = the
              # posting client. Ack AFTER the dispatch — the outbox is FIFO, so a handler's
              # synchronous `client.postMessage` reply (`sw_client_msg`) is guaranteed to precede
              # the `swack`; acking first opens a window where the main thread sees the pending
              # count hit zero (worker_pending? false) while the handler is still running, and the
              # virtual clock fast-forwards past the caller's timeout before the reply lands. The
              # `ensure` keeps a raising handler from leaking the counter and hanging settle.
              begin
                rt.call('__csim_swClientMessage', msg[:data], msg[:client], msg[:url])
                # A synchronously-resolved waitUntil must settle NOW: its allSettled
                # continuation flips the extended-lifetime counter back to 0 (the
                # try-activate release), and nothing else drains this isolate's
                # microtasks until the next timer-bearing tick.
                rt.drain_microtasks
              ensure
                # The message is dispatched — it no longer extends this worker's
                # lifetime (the counter service_worker_post_message bumped). If that
                # was the LAST hold — no unsettled waitUntil either — post a
                # try-activate of our own: the extended hook's 0-transition fires
                # INSIDE the rt.call above (the engine runs a microtask checkpoint at
                # the call boundary), so its try_activate can be consumed by the main
                # thread while this counter still reads 1; without a wakeup issued
                # AFTER the decrement, that release is lost and a parked activation
                # hangs (activation.https 'finishing a request…' TIMEOUT). Every
                # hold-clearing transition posts its own try_activate — this one, the
                # extended 0-transition, unregister_client, skipWaiting, reap_worker —
                # so the gate's cross-thread reads only ever miss a wakeup that a later
                # one repeats. Locked against the main thread's increment (a lost
                # increment would read as "no holds" with a message still queued).
                if (wk = @workers[handle])
                  none_left = @worker_init_lock.synchronize {
                    wk[:sw_msgs] = [0, wk[:sw_msgs].to_i - 1].max
                    !wk[:extended] && wk[:sw_msgs].zero?
                  }
                  outbox << {handle: handle, kind: 'sw_try_activate'} if none_left
                end
                outbox << {handle: handle, kind: 'swack'}
              end
            elsif msg.is_a?(Hash) && msg[:kind] == 'ws'
              # One of this worker's WebSockets: its event delivered here, as the window's are at settle — a handshake
              # cookie stored in the jar, not handed to the script.
              ev = msg[:event]
              if ev[:type] == '__setcookie'
                merge_set_cookie({'set-cookie' => ev[:cookies]}, ev[:url])
              else
                rt.call('__csim_deliverWebSocketEvents', [ev])
              end
            elsif msg.is_a?(Hash) && msg[:kind] == 'port_msg'
              # A message for a channel end THIS worker holds: deliver it to that port. Counted like an
              # sw_message (deliver_port_message incremented @sw_message_pending), so ack AFTER dispatch
              # under `ensure` — a synchronous reply the port handler posts back (another port_msg on the
              # outbox) is FIFO-guaranteed to precede this swack.
              begin
                rt.call('__csimPortEndDeliver', msg[:end], msg[:data])
              ensure
                outbox << {handle: handle, kind: 'swack'}
              end
            elsif msg.is_a?(Hash) && msg[:kind] == 'client_navigate_result'
              # The outcome of a WindowClient.navigate() this worker is awaiting — settles the
              # promise it is holding (js/src/workers.js __csim_swClientNavigateResult).
              rt.call('__csim_swClientNavigateResult', msg[:nav_id], msg[:url], msg[:client], msg[:error])
            elsif msg.is_a?(Hash) && msg[:kind] == 'unregister_result'
              # The main thread ran this worker's own `registration.unregister()` job — settle
              # the parked promise. Drain: its continuation is what posts the test's reply
              # (`unregister().then(() => port.postMessage(...))`), and nothing else drains
              # this isolate's microtasks until the next timer-bearing tick.
              rt.call('__csim_swUnregisterResult', msg[:ok])
              rt.drain_microtasks
            elsif msg.is_a?(Hash) && msg[:kind] == 'sw_client_message'
              # A service worker → THIS worker, which is one of its clients: `client.postMessage`
              # targets the client's `navigator.serviceWorker` 'message' event, which a worker
              # isolate has just like a document (WorkerNavigator.serviceWorker). Fire-and-forget —
              # the SW's send is not awaiting a reply.
              rt.call('__csim_swDeliverClientMessage', msg[:data], msg[:handle])
            elsif msg.is_a?(Hash) && msg[:kind] == 'fetch'
              # A controlled client's fetch: dispatch a `fetch` event. The SW's respondWith result
              # (or a fall-through / network-error marker) is posted back as a `fetch_response`
              # outbox event, which releases the @sw_fetch_pending counted for this request. A
              # synchronous respondWith posts during the dispatch; an async one posts under the
              # drain. If the dispatch itself dies (engine raise, Thread#kill) the JS side can
              # never post — fall the client back to the network so the counter drains (a
              # duplicate response is harmless: the client's pendingFetch entry is one-shot).
              dispatched = false
              begin
                rt.call('__csim_swDispatchFetch', msg[:req], msg[:fetch_id], msg[:realm_id])
                dispatched = true
              ensure
                sw_deliver_fetch_response(handle, msg[:fetch_id].to_i, '{"fallthrough":true}', outbox, msg[:realm_id].to_i) unless dispatched
              end
            elsif msg.is_a?(Hash) && msg[:kind] == 'sw_fetch_response'
              # THIS worker is a controlled CLIENT whose fetch went through its SW
              # (__csimSWInterceptFetch tagged realm -handle): resolve the pending fetch in
              # this isolate, the mirror of deliver_worker_messages' realm_call for pages.
              # BUSY for the whole span (like the postMessage branch): the `.then` chain's
              # observable output isn't posted yet, and every other pending counter reads 0
              # here — without the hold a drain can bail mid-chain.
              @worker_init_lock.synchronize { @worker_busy += 1 }
              busy_held = true
              rt.call('__csim_swControllerFetchResponse', msg[:fetch_id], msg[:resp])
              drive_worker_to_quiescence(rt, stopping)
            elsif msg.is_a?(Hash) && msg[:kind] == 'nested_worker_msgs'
              # Postbacks from a NESTED worker this isolate created — dispatch on its
              # Worker objects here (deliver_worker_messages routed them by parentage).
              # BUSY for the span: the handlers' own postbacks aren't out yet and no
              # counter covers the gap (same shape as sw_fetch_response).
              @worker_init_lock.synchronize { @worker_busy += 1 }
              busy_held = true
              # (…each a task of its own, as the window-side delivery's: workers.js `deliverWorkerEvent`)
              rt.call('__csim_deliverWorkerMessages', msg[:events])
              drive_worker_to_quiescence(rt, stopping)
            elsif msg.is_a?(Hash) && msg[:kind] == 'claim_client'
              # clients.claim() reaches worker clients too: adopt the claiming SW as this
              # isolate's controller when this worker's script URL is in scope (the same
              # self-check pages run — __csim_swClaimClient compares against location).
              rt.call('__csim_swClaimClient', msg[:handle], msg[:has_fetch], msg[:script_url], msg[:scope], msg[:all_scopes])
            elsif msg.is_a?(Hash) && msg[:kind] == 'fetch_cancel'
              # The client cancelled this streaming respondWith body — cancel the reader
              # streamDeliver is draining, firing the SW source stream's `cancel()`. Fire-and-forget:
              # the reader's cancellation resolves its read as done, emitting the terminal frame that
              # clears @sw_fetch_pending; no ack/counter of its own.
              rt.call('__csim_swStreamCancel', msg[:fetch_id])
            elsif msg
              # Mark BUSY for the whole span of this postMessage handler. Unlike the SW /
              # broadcast branches above (each tracked by its own pending counter),
              # `@worker_in_flight` under-counts a multi-reply handshake to 0 mid-flight (one
              # request → many progress replies + a final resolve), so `worker_pending?` would
              # go false while the worker is still working and settle would abandon the
              # protocol between replies. Keep it true until the handler returns.
              @worker_init_lock.synchronize { @worker_busy += 1 }
              busy_held = true
              # A plain worker postMessage handler can start a multi-stage async bring-up
              # that alternates microtasks and timers — most sharply Emscripten's WASM
              # runtime init (addRunDependency → read the binary on a setTimeout(0) →
              # WebAssembly.instantiate → removeRunDependency → run() → onRuntimeInitialized
              # → the module factory's `.then`). Draining once leaves the microtask layers a
              # fired timer queued *after the last timer* stranded, so the factory promise
              # never settles (Tesseract hangs at "initializing tesseract"). Run the worker's
              # own event loop to quiescence instead of a single gated tick.
              rt.call('__csim_workerOnMessage', msg)
              drive_worker_to_quiescence(rt, stopping)
            end
            # (…a quiet tick's once: a second run at the same instant fired the 0 ms task a timer of the first queued — a
            # network response, a fetch's or an XHR's, at the time it was sent, which no network answers in)
            run_worker_timers.call(0) if msg
            # Whether the worker has a timer left, after the message, is told to the main thread, whose waits go on
            # while it does (`polling?`) — and how soon, for the window's event loop, whose page waits on it
            # (`worker_next_timer`).
            if record
              next_timer = stopping.call ? -1.0 : rt.call('__nextTimerDelay').to_f
              record[:timers_due] = next_timer >= 0
              record[:next_timer] = next_timer
            end
            # A lifecycle phase whose `waitUntil` was parked at boot may have settled off
            # the message dispatch / timer drain above (the extendable-event SYN/ACK, the
            # fetch-waits-for-activate 'ACTIVATE' resolve) — advance it. `sw_check_phase`
            # nils its own pending state when the engine completes, so this is a single
            # host call per tick only while a service worker's lifecycle is still open.
            sw_check_phase&.call
            if busy_held
              @worker_init_lock.synchronize { @worker_busy -= 1 }
              busy_held = false
            end
            break if rt.call('__csimWorkerClosedRead')
          end
        end
      rescue StandardError => e
        # …unless the raise IS the stop we were asked for. `terminate` ends the call in flight with
        # a `ScriptTerminatedError`, which reaches here where `Thread#kill` never did — and posting
        # that as a script failure fails a still-running Register / Update job with "the
        # script evaluation failed" for a failure that did not happen.
        unless stopping.call
          # A SERVICE worker dying before its eval-outcome was posted (engine boot / script
          # fetch raise) must still settle the job waiting on it.
          outbox << {handle: handle, kind: 'sw_eval', ok: false, msg: "#{e.class}: #{e.message}"} if service
          outbox << {handle: handle, kind: '__error', message: "#{e.class}: #{e.message}"}
        end
      ensure
        # A service worker exiting with a lifecycle phase still OPEN — a raise on this
        # thread, `self.close()` during a parked install waitUntil, a terminate — can
        # never settle that phase itself, and the client timeline parked on its marker
        # would hang with a phantom installing/activating worker. Post the terminal
        # marker here: an unfinished install is a FAILED install (ok:false → redundant);
        # an unfinished activate still activates (the spec ignores activate failure).
        if service && sw_phase_pending
          outbox << if sw_phase_pending == 'install'
            {handle: handle, kind: 'sw_phase', phase: 'install', ok: false}
          else
            {handle: handle, kind: 'sw_phase', phase: 'activated'}
          end
        end
        # A raise between the busy bump and its matching decrement would strand the
        # counter; balance it here so worker_pending? can't stick true after this thread dies.
        @worker_init_lock.synchronize { @worker_busy -= 1 } if busy_held
        release_init.call   # guarantee the init count is released on an early raise
        # Its WebSockets go with it (HTML "worker event loop" teardown: each made to disappear).
        ws_drop_client(handle)
        # Take the runtime back from the boundary BEFORE destroying it, and destroy it while
        # holding the lock: terminating a disposed isolate is a use-after-free, and the two calls
        # are on different threads. Whoever holds the lock owns the pointer for that moment.
        if record
          record[:timers_due] = false
          record[:rt_lock].synchronize { record[:rt] = nil; rt&.dispose }
        else
          rt&.dispose
        end
      end

      # Bundlers that ship a worker inline as a Blob (Tesseract,
      # Webpack `?worker` imports, Vite worker chunks) construct
      # `new Worker(blobURL)`. Rack can't parse `blob:` so short-
      # circuit to the JS-side blob registry instead. Http(s) URLs
      # fall through to the regular Rack path.
      # A worker's script, run as a top-level Script; an exception it throws is the worker's to report (HTML "report an
      # exception": workers.js __csimReportWorkerScriptError) — its message and the place of its top frame, what the
      # host's evaluation keeps of it — and the worker runs on.
      private def run_worker_script(rt, body, url)
        rt.eval_void("#{body}\n//# sourceURL=#{url.tr("\n", ' ')}")
      rescue RustyRacer::ParseError => e
        message, line = e.message.match(/\A(.*) at \S+?:(\d+)\z/m)&.captures
        rt.call('__csimReportWorkerScriptError', message || e.message, url, line.to_i, 0)
      rescue RustyRacer::RuntimeError => e
        file, line, col = e.backtrace.to_a.first.to_s.match(/\(?([^\s()]+):(\d+):(\d+)\)?\z/)&.captures
        rt.call('__csimReportWorkerScriptError', e.message, file || url, line.to_i, col.to_i)
      end

      # …and a module worker's (`{type: 'module'}`) as a module graph, its static imports fetched on the worker's thread as
      # a module script's are — a 2xx response of a JavaScript MIME type (Chrome enforces it for module scripts whatever
      # the server) — one that cannot be fetched, parsed or linked failing the graph: a plain `error` at the Worker, no
      # exception to report (HTML "run a worker": its script null, or its error to rethrow set). An exception its
      # evaluation throws is reported as a classic script's is (`eval_module_graph`).
      private def run_worker_module(rt, body, url, handle, outbox, module_fetch)
        rt.eval_module_graph(body, url, module_fetch, service: false)
      rescue ModuleScriptUnavailable, RustyRacer::ParseError, RustyRacer::RuntimeError => e
        outbox << {handle: handle, kind: '__error', message: "#{e.class}: #{e.message}"}
      end
      # …the fetch of a module worker `handle` (of `worker_url`) imports, statically or by `import()` — HTML "fetch a single
      # module script": a request of mode 'cors' whose client is the worker, through the service worker that controls it
      # (`controller`), the network where that answers nothing; a `blob:` one's bytes the window's registry holds (read
      # here, on the worker's thread: blob_registry.rs), a `data:` one's its own — each a 2xx response of a JavaScript MIME
      # type, or none at all. Its source and its URL — the response's, a redirect's end, which its own imports resolve
      # against and its `import.meta.url` reports.
      private def worker_module_fetch(handle, controller, worker_url)
        lambda do |abs|
          if abs.start_with?('blob:')
            maker = Native.blob_registry_partition(@blob_window, abs)&.first
            bytes = maker && Native.blob_registry_get(maker, abs)
            raise ModuleScriptUnavailable, abs unless bytes

            next [bytes, abs]
          end
          if abs.start_with?('data:')
            mime, bytes = Native.data_url(abs)
            raise ModuleScriptUnavailable, abs unless bytes && js_mime_type?(mime)

            next [bytes, abs]
          end
          r = controller.positive? && abs.match?(%r{\Ahttps?://}i) ? sw_direct_fetch(controller, JSON.generate(
            method: 'GET', url: abs, headers: {}, body_b64: '', mode: 'cors', destination: 'script',
            credentials: 'same-origin', clientId: sw_worker_client_id(handle)
          ), handle) : nil
          if r && !r['fallthrough']
            raise ModuleScriptUnavailable, abs if r['networkError'] || !sw_response_allowed?(r, 'cors')

            r = {'status' => r['status'], 'headers' => r['headers'] || {}, 'body' => Base64.decode64(r['body_b64'].to_s), 'url' => r['url']}
          else
            r = rack_fetch('GET', abs, '', {}, 'follow', 'cors', client_url: worker_url)
            raise ModuleScriptUnavailable, abs unless resource_loaded?(r)
          end
          ct = r['headers'].find {|k, _| k.to_s.casecmp('content-type').zero? }&.last
          raise ModuleScriptUnavailable, abs unless (200..299).cover?(r['status'].to_i) && js_mime_type?(ct)

          [r['body'].to_s, r['url'].to_s.empty? ? abs : r['url'].to_s]
        end
      end
      # (…a module script the graph cannot have: unfetched, failed, or of no JavaScript MIME type)
      class ModuleScriptUnavailable < StandardError; end

      # A worker's script, of `url`: an http(s) one fetched in mode 'same-origin' against its creator's URL `client_url` —
      # a cross-origin URL or redirect a network error, as for a classic and a module worker alike (HTML "fetch a classic
      # worker script", "fetch a single module script") — which fires the worker's `error`.
      # (…its client of an opaque origin — a sandboxed frame's — one no http(s) script is same-origin with: a network error,
      # the worker's `error`)
      private def fetch_worker_script(url, client_url, opaque: false)
        u = url.to_s
        if u.start_with?('blob:')
          # Resolve via the Driver's partition store so a SAME-partition blob created
          # in ANOTHER window/isolate (the cross-partition-worker-creation test creates
          # the blob in the opener and the worker in a same-site iframe) is readable.
          # Falls back to this realm's own store when there's no Driver entry.
          if @driver.respond_to?(:blob_bytes_for) && (data = @driver.blob_bytes_for(u, self))
            return data[:bytes]
          end
          # (…the isolate's store, whichever of its realms made it — `new Worker(blobURL)` from a data: iframe —
          # else the window's registry, where a worker's isolate entered its bytes: `__csimReadBlobBytes`)
          bytes = @runtime.call('__csimReadBlobBytes', u)
          return nil if bytes.nil? || bytes.empty?
          return bytes
        end
        # `data:[<mediatype>][;base64],<data>` worker scripts (a worker created
        # from a data: URL — its origin is opaque, so its blob: URLs serialize
        # with a 'null' origin). Decode inline; Rack can't serve a data: URL.
        return decode_data_url_body(u) if u.start_with?('data:')
        rack_fetch_body(u, cors_mode: 'same-origin', client_url: client_url, client_origin: opaque ? 'null' : nil)
      end

      # The decoded body of a `data:` URL, by Fetch's data: URL processor (the engine's, the page's too) — empty for one
      # it fails.
      private def decode_data_url_body(url) = Native.data_url(url)&.last || ''

      # Run a worker isolate's own event loop until it goes idle NOW: drain microtasks,
      # then — if a timer is already due — fire it and loop, so the microtasks that
      # timer's callback queues get drained in turn. A single `drain_microtasks;
      # drain_timers` pair strands whatever the last-fired timer queued, which is exactly
      # how Emscripten's WASM bring-up stalls (`removeRunDependency` runs only after the
      # binary-read setTimeout(0), and its `run()` → `onRuntimeInitialized` continuation
      # is a bare microtask with no further timer to re-trigger a gated drain). Only
      # what is due: the worker's clock is the window's (`worker_clock_step`), so a
      # later timer waits for the window's clock to reach it rather than firing with
      # none of it gone by. Bounded by WORKER_QUIESCE_MAX_ROUNDS so a self-perpetuating
      # 0 ms timer yields back to the poll loop rather than pinning the thread.
      # `stopping`: asked between rounds, because this loop is the other place a worker can spend
      # seconds — 256 rounds, each a drain whose budget one long timer callback can overrun.
      # `terminate` ends whichever round is running; this check ends the loop between rounds.
      private def drive_worker_to_quiescence(rt, stopping = nil)
        WORKER_QUIESCE_MAX_ROUNDS.times do
          rt.drain_microtasks
          break unless rt.call('__nextTimerDelay').to_f.zero?
          break if stopping&.call
          rt.drain_timers(0)
        end
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

      # Each realm's document's import map (import_map.rs, as JSON), which the realm's `registerImportMap` keeps and pushes
      # here, by realm id, so the host resolves a realm's module specifiers as that realm does — a frame's map neither
      # replaces its parent's nor clears it.
      def set_importmap(json, realm)
        (@importmaps ||= {})[realm.to_i] = json.to_s
      end

      # …gone with its realm.
      def forget_importmap(realm)
        @importmaps&.delete(realm.to_i)
      end

      # Import-map "integrity" metadata for a RESOLVED module URL in `realm` ('' when unmapped).
      def importmap_integrity(url, realm)
        map = @importmaps&.[](realm.to_i)
        map ? Native.import_map_integrity(map, url.to_s) : ''
      end

      # HTML "resolve a module specifier" against `base_url` (the referrer's) through `realm`'s import map: the URL, or
      # the specifier itself where it resolves to none (a bare one nothing maps), which then fails to fetch.
      def resolve_module_specifier(specifier, base_url, realm)
        base = effective_module_base(base_url)
        Native.import_map_resolve(@importmaps&.[](realm.to_i) || '', specifier.to_s, base) || specifier
      end

      # The base a module specifier resolves against: the importer's URL — for a nested relative import, and for a
      # dynamic `import()` the referring script's. An inline script / module has no real URL — its pseudo-name is
      # `<eval>` (no scheme, from V8) or `inline://<hash>` (from `__csim_runScript`) — so it resolves against the PAGE URL.
      private def effective_module_base(base)
        base = nil unless base.is_a?(String) && base =~ %r{\A[a-z]+://}i && !base.start_with?('inline:')
        base || @current_url || @default_host
      end

      def resolve_against(url, base)
        return url if url =~ %r{\A[a-z]+://}i
        eff = effective_module_base(base)
        # Memo of `url` parsed against `eff` — a pure function of (effective base, url).
        # A heavy ESM app re-resolves the same ~80 module specifiers against the
        # same base on every visit (a fresh VM re-instantiates the whole module
        # graph); Ruby's URI parser was a measured ~11% of per-visit wall. The
        # Browser persists across a suite's visits, so this instance-level memo
        # (same scope/threading assumptions as @importmap / @current_url) turns
        # all but the first visit's resolves into hash hits.
        cache = (@resolve_against_cache ||= {})
        cache[[eff, url]] ||= parse_url(url.to_s, eff)&.fetch(:href) || url
      end

      # Fetch caps a request at 20 redirects: the 21st is a network error (redirect-count).
      # The loop below runs one iteration PER dispatch, so it needs 20 redirect hops plus
      # the final response — MAX_FETCH_REDIRECTS + 1 iterations — to let exactly 20 succeed.
      MAX_FETCH_REDIRECTS = 20
      # Request cache modes that never READ the store (always hit the network), and modes that
      # serve a STORED response even when stale. Frozen so the hot rack_fetch path allocates no
      # throwaway arrays per hop (perf).
      CACHE_MODES_SKIP_READ  = %w[no-store reload].freeze
      CACHE_MODES_SERVE_STALE = %w[force-cache only-if-cached].freeze
      REFERRER_POLICIES = %w[
        no-referrer no-referrer-when-downgrade origin origin-when-cross-origin
        same-origin strict-origin strict-origin-when-cross-origin unsafe-url
      ].freeze
      # The policy of a document no `<meta name="referrer">` or header sets one for (Referrer Policy §3).
      DEFAULT_REFERRER_POLICY = 'strict-origin-when-cross-origin'

      # The `Referer` value a request carries under a Referrer-Policy — nil = send none
      # (https://w3c.github.io/webappsec-referrer-policy/#determine-requests-referrer).
      # `referrer_url` is the request's referrer (the initiating document); `target_url`
      # its destination. "full" is the referrer stripped of fragment + credentials;
      # "origin" is scheme://host[:port]/. An empty / unknown policy → the default
      # (strict-origin-when-cross-origin).
      def compute_referrer(policy, referrer_url, target_url)
        return nil if referrer_url.nil? || referrer_url.to_s.empty?
        policy = DEFAULT_REFERRER_POLICY unless REFERRER_POLICIES.include?(policy)
        return nil if policy == 'no-referrer'
        # The referrer is almost always the (constant) document URL — memoise its parse
        # so the rack_fetch hot path doesn't re-parse it per request (rule 3).
        ref = parse_referrer_url(referrer_url)
        return nil unless ref && %w[http: https:].include?(ref[:protocol])
        full        = -> { referrer_of(ref) }
        origin_only = -> { "#{ref[:origin]}/" }
        return full.call        if policy == 'unsafe-url'
        return origin_only.call if policy == 'origin'
        # The remaining policies need the target to know same-origin / downgrade.
        tgt = parse_url(target_url.to_s)
        return nil unless tgt
        same_origin = ref[:origin] == tgt[:origin]
        downgrade   = ref[:protocol] == 'https:' && tgt[:protocol] == 'http:'
        case policy
        when 'origin-when-cross-origin'        then same_origin ? full.call : origin_only.call
        when 'same-origin'                     then same_origin ? full.call : nil
        when 'strict-origin'                   then downgrade ? nil : origin_only.call
        when 'no-referrer-when-downgrade'      then downgrade ? nil : full.call
        when 'strict-origin-when-cross-origin' then same_origin ? full.call : (downgrade ? nil : origin_only.call)
        end
      end

      # Parse a referrer URL, memoising the last one (the referrer is the document URL
      # for nearly every request, so this caches across the whole page's subresources).
      def parse_referrer_url(url)
        return @referrer_parsed if defined?(@referrer_parsed_for) && @referrer_parsed_for == url
        @referrer_parsed_for = url
        @referrer_parsed     = parse_url(url.to_s)
      end

      # The `Referer` a request sends for the referrer `url`, or nil for none: stripped (a fragment had been sent), and
      # none for a URL of a local scheme (`about:srcdoc`, `about:blank`, `blob:`, `data:`) — Referrer Policy's "strip url
      # for use as a referrer" step 1.
      def referrer_header(url)
        parts = parse_url(url.to_s)
        parts && %w[http: https:].include?(parts[:protocol]) ? referrer_of(parts) : nil
      end

      # A URL as a referrer: no fragment, no credentials (Referrer Policy "strip url").
      def referrer_of(url)
        "#{url[:protocol]}//#{url[:host]}#{url[:pathname]}#{url[:search]}"
      end

      # Whether a request to `url_str` must be blocked as a Fetch "bad port". Cheap
      # pre-gate: only URLs whose authority carries an explicit `:<digit>` are parsed
      # (the vast majority don't), so the rack_fetch hot path — every asset / xhr /
      # fetch, cache hits included — skips URI.parse entirely.
      def bad_port?(url_str)
        return false unless url_str =~ %r{\A[a-z]+://[^/]*:\d}i
        port = parse_url(url_str)&.fetch(:port).to_s
        !port.empty? && Native.bad_port(port.to_i)
      end

      # URLs we won't even try to route through Rack: anything that
      # isn't http(s) (data: / mailto: / about:) plus pseudo-tokens
      # like V8's `<snapshot>` that sourcemap libraries pull out of
      # error stacks and feed straight to `fetch()` / `xhr.open()`.
      def rack_fetch(method, url, body, headers, redirect_mode, cors_mode = nil, credentials: 'same-origin', env_extras: nil, referrer_policy: nil, referrer: nil, cache_mode: 'default', initiator: nil, site_seed: nil, origin_null: false, client_url: nil, cookie_cross_site: false, nav_dest: nil, body_raw: false, client_origin: nil, client_realm: nil, navigation: false)
        # NB: a relative fetch/XHR URL is resolved against the document's API base URL
        # at OPEN time (XHR open() / fetch()), in JS, NOT here — resolving at send time
        # would wrongly pick up a `<base href>` inserted after open() (open-url-base
        # -inserted-after-open). So this resolves only against the document URL — a relative one: an absolute URL is the
        # request's as it is, which also keeps a worker thread's fetch (its URLs resolved in its own isolate) off the main
        # realm, whose current document only its own thread may ask about. (An absolute URL is taken as already serialized:
        # every caller resolves it first, JS-side or through parse_url / resolve_against.)
        target = url.to_s.match?(%r{\Ahttps?://}i) ? url.to_s : resolve_against_current(url.to_s)
        return nil unless target.is_a?(String) && target.match?(%r{\Ahttps?://}i)
        # Fetch "port blocking" (https://fetch.spec.whatwg.org/#port-blocking): a
        # request to a blocked port is a network error before any connection —
        # fetch() rejects with TypeError, a sync XHR throws NetworkError
        # (request-bad-port). Re-checked per redirect hop below ("HTTP-redirect fetch"
        # re-runs the block), so a 3xx Location to a bad port is refused too.
        return nil if bad_port?(target)
        # CORS enforcement (preflight + Access-Control checks) applies only to cors_mode
        # 'cors' — sent by XHR and by fetch()'s default mode. fetch() also threads
        # 'no-cors' / 'same-origin' (mode semantics below), and a form-submission
        # navigation threads 'navigate'; other callers (sendBeacon, ESM, workers, the
        # internal asset GET) pass nil → no CORS and no mode semantics. The document's
        # origin is the request's origin; a different target origin is cross-origin.
        cors        = cors_mode == 'cors'
        # The CLIENT is the realm that called fetch/XHR — its own location (a Service
        # Worker's script URL, a frame document's URL), threaded from JS; the top-level
        # @current_url is only the fallback. It is the request's SINGLE origin identity:
        # URL resolution (JS-side, vs the realm's baseURI), the response-taint verdict
        # (doc_origin), CORS enforcement and the Origin header (req_origin) must all
        # agree, or a frame's request to its OWN origin is judged cross-origin vs the
        # top document (the cross-origin login iframe's Basic-auth XHR pre-flighted
        # and died — fetch-canvas-tainting &Auth; an SW's own fetch() likewise judges
        # vs its OWN script origin, not the page it controls).
        # Only a REAL http(s) client URL carries origin identity; an opaque-origin
        # context (about:blank / javascript: / data: realm reporting its own location)
        # falls back to the top document, keeping the creator-inherited behavior those
        # contexts had before client threading.
        client = client_url.to_s.match?(%r{\Ahttps?://}i) ? client_url : @current_url
        # …and its ORIGIN, where the realm says it (`client_origin`, its document's): a sandboxed document at a real URL
        # is of an opaque origin ("null") its URL does not carry — every request it makes cross-origin, as Fetch has it.
        client_origin = client_origin.to_s.empty? ? url_origin(client) : client_origin.to_s
        # The request's origin for EVERY fetch mode — Fetch appends an Origin header to
        # every non-GET/HEAD request regardless of mode (a same-origin or no-cors
        # POST/PUT still carries it, for the server's CSRF/Origin check). CORS
        # enforcement itself stays gated on `cors` below; a nil-mode internal caller
        # (navigation / asset GET) has no origin semantics. An explicit `initiator` (a SW
        # re-issuing a navigation via `fetch(event.request)`) is the request's origin for
        # ALL modes — so a passthrough 'navigate'-mode POST still carries its Origin — and a document's own navigation
        # request (`navigation`: a form submission's of a frame) is of its document's origin.
        req_origin  = initiator || (navigation || %w[cors no-cors same-origin].include?(cors_mode) ? client_origin : nil)
        # Fetch request "mode" (fetch threads it; XHR is always 'cors'; a non-fetch/xhr
        # caller passes nil → no mode semantics, a plain 'basic' response). `no-cors`
        # filters a cross-origin response to opaque; `same-origin` makes a cross-origin
        # request a network error. `doc_origin` detects cross-origin for the response
        # TYPE regardless of whether CORS enforcement (cors) runs; `crossed` latches once
        # any hop leaves the document origin.
        no_cors_mode     = cors_mode == 'no-cors'
        same_origin_mode = cors_mode == 'same-origin'
        doc_origin       = %w[cors no-cors same-origin].include?(cors_mode) ? client_origin : nil
        crossed          = false
        # Sec-Fetch-Site latches the widest initiator↔hop relationship across the redirect chain
        # (like the navigation path), computed vs the request's referrer-source origin below. A SW
        # re-fetch seeds it with the widened site the network hops accumulated BEFORE the SW
        # intercepted the final hop (a same-site redirect the passthrough must keep reporting).
        sec_site         = site_seed
        # A request is "credentialed" (cookies + the credentialed CORS check) only in
        # `include` mode; `same-origin` (default) and `omit` are uncredentialed for the
        # CORS check, while the cookie decision below distinguishes all three.
        with_credentials = credentials == 'include'
        # Use the method's case AS GIVEN: the JS callers already applied the spec
        # normalization (XHR open() / Fetch upper-case the known methods, preserving
        # an unknown method's case — open-method-case-sensitive). Upper-casing here
        # would clobber a custom method like `xUNIcorn`.
        method = (method || 'GET').to_s
        redirected = false
        # CHALLENGE credentials for transparent HTTP Basic auth — set by the XHR authentication path
        # (open() user/password / URL userinfo), NOT a raw setRequestHeader('Authorization'). They are
        # NOT sent proactively; a 401 "Basic" challenge triggers a single re-send with them (below).
        # Strip the marker so it never reaches the server.
        challenge_authz = nil
        if headers.is_a?(Hash) && (mk = headers.keys.find {|k| k.to_s.casecmp?('x-csim-auth-challenge') })
          challenge_authz = 'Basic ' + headers[mk].to_s
          headers = headers.reject {|k, _| k == mk }
        end
        # The request's origin starts as the document origin; a cross-origin REDIRECT
        # taints it to an opaque origin (serialized "null") per Fetch "HTTP-redirect
        # fetch". `effective_origin` IS that origin — it's what the Origin header
        # carries and what the CORS check / preflight compare against from that hop on
        # ('null' once tainted, so the server must then allow 'null' or '*'). A SW re-fetch whose
        # navigation ALREADY crossed origin via a network redirect starts tainted (origin_null).
        effective_origin = origin_null ? 'null' : req_origin
        # Virtual server delay (a handler's `time.sleep`, see wpt_py_handler.py) accumulated across
        # EVERY sub-request this fetch makes — the CORS preflight AND every redirect hop — since the
        # `timeout` a client applies spans them all and a redirect/preflight must not reset it
        # (timeout-multiple-fetches). Reset per fetch; the final response carries the total.
        # THREAD-LOCAL: keepalive/race legs run rack_fetch concurrently with the main
        # thread — a shared ivar would cross-contaminate their delay totals.
        Thread.current[:csim_fetch_server_delay_ms] = 0
        # An author conditional (If-None-Match / …) means the caller is doing its own
        # revalidation, so the UA cache must step aside (computed once — the headers
        # carrying it survive every redirect hop unchanged).
        skip_cache = request_has_conditional_headers?(headers)
        ref_policy = referrer_policy   # may be overridden per hop by a response Referrer-Policy
        # The referrer is stripped PROGRESSIVELY: each hop applies its (possibly
        # overridden) policy to the referrer the PREVIOUS hop sent, not to the original
        # document — so once a hop reduces it to an origin (or drops it), a later, laxer
        # policy can't widen it back (redirect-referrer-override). The initial source is
        # the request's referrer: an explicit `init.referrer` URL when given, else the
        # document URL ("client"); an empty referrer means no-referrer (compute_referrer
        # maps a blank source to nil).
        ref_source = referrer.nil? ? client : referrer
        # The request's INITIATOR origin for Sec-Fetch-Site — captured ONCE (loop-invariant), before
        # the per-hop referrer reassignment (5927 below) degrades ref_source, and independent of
        # Referrer-Policy: the initiator is the referrer's origin (a SW's `fetch(event.request)`
        # carries the navigating frame's origin here, so a cross-origin passthrough is same-/cross-site
        # correctly), falling back to the document origin when the referrer was policy-emptied — never
        # 'none' for a request that has a real initiator. An explicit `initiator` is authoritative:
        # it survives the referrer reset a `new Request(event.request, init)` performs (referrer →
        # about:client), so a SW's change-request re-fetch is same-origin to the SW's own script.
        sec_initiator = initiator || url_origin(ref_source) || url_origin(@current_url)
        # (…the site for cookies and the client it is judged by, kept across the hops: a redirect back to the client's own
        # site is still a cross-site chain's)
        cookie_site = cookie_client = nil
        # …which a hop to `hop` widens (RFC 6265bis "site for cookies"): a script fetch's by its client document's site
        # against the hop's; a mode-less load's — an image's, a font's, a style sheet's, the host's for a document — by its
        # client's and its top-level document's; a client of an opaque origin (`null`, `data:`) cross-site
        # (cookie_cross_site_document?); one a frame's document made (`client_realm`, which the bindings name) by that
        # frame's ancestors too, the top-level document included (its own document is the client); a dedicated worker's
        # by the site for cookies it was made with (worker_cross_site?). None for a load with no client at all.
        widen_cookie_site = lambda {|hop|
          cookie_client ||= cors_mode ? (doc_origin || sec_initiator) : (client_url || sec_initiator)
          next if cookie_client.nil?

          cross = cookie_cross_site_document?(cookie_client, hop) ||
                  (!cors_mode && !@current_url.nil? && cookie_cross_site_document?(@current_url, hop)) ||
                  (client_realm.to_i.positive? && frame_ancestor_cross_site?(client_realm, hop)) ||
                  worker_cross_site?(hop)
          cookie_site = widen_sec_fetch_site(cookie_site, cross ? 'cross-site' : sec_fetch_site(cookie_client, hop))
        }
        (MAX_FETCH_REDIRECTS + 1).times do
          t0 = @trace && Process.clock_gettime(Process::CLOCK_MONOTONIC)
          # Cross-origin-ness for the request mode/type, latched across hops. Computed
          # BEFORE the cache so a cross-origin request never takes the cache fast path
          # (which would bypass the opaque filter / same-origin-mode error / cors type).
          crossed ||= !!(doc_origin && (effective_origin == 'null' || url_origin(target) != doc_origin))
          return nil if same_origin_mode && crossed   # 'same-origin' mode forbids a cross-origin hop
          # HTTP cache (RFC 9111 + Fetch "HTTP-network-or-cache fetch"), gated by the request's
          # cache MODE. GET-only, same-origin (a cross-origin hop always redispatches so the mode
          # filtering below runs), and stepped aside when the author sent their own conditional.
          #   - no-store / reload    : never read the store — always hit the network, no conditional
          #   - force-cache / only-if-cached : serve a stored response even when STALE, no revalidation
          #                                    (only-if-cached with nothing stored is a network error)
          #   - no-cache             : always revalidate, even a fresh entry
          #   - default              : serve fresh; revalidate stale (fall through with conditionals)
          read_cache  = method == 'GET' && !skip_cache && !crossed && !CACHE_MODES_SKIP_READ.include?(cache_mode)
          cache_entry = read_cache ? @@asset_cache.lookup(target) : nil
          serve_stored = cache_entry &&
            (CACHE_MODES_SERVE_STALE.include?(cache_mode) || (cache_entry.fresh? && cache_mode != 'no-cache'))
          if serve_stored
            if REDIRECT_STATUSES.include?(cache_entry.status.to_i)
              # A cached REDIRECT obeys the redirect mode exactly like a fresh one: `error` is a
              # network error, `manual` is an opaque-redirect, and `follow` follows it THROUGH
              # the cache — resolve the Location and continue so the next hop serves the cached
              # target (request-cache "uses cached … redirects"). only-if-cached / force-cache
              # reach this only same-origin GET (read_cache excludes cross-origin), so there's no
              # method rewrite / origin taint.
              raise StandardError, '[capybara-simulated] fetch: redirect blocked by redirect=error mode' if redirect_mode == 'error'
              if redirect_mode != 'follow'
                return opaque_redirect_hash(target, cache_entry.status, cache_entry.headers, cache_entry.body)
              end
              if (loc = redirect_location(cache_entry.status, cache_entry.headers))
                trace_network(method, target, cache_entry.status, headers, body, cache_entry.headers, nil, t0, true)
                widen_cookie_site.(target) unless cors_mode == 'navigate'   # (…a hop the cache answered a hop all the same)
                redirected = true
                next_url   = resolve_against(loc, target)
                return nil unless next_url.to_s.match?(%r{\Ahttps?://}i)
                target = carry_fragment(target, next_url)
                return nil if bad_port?(target)   # a cached redirect to a blocked port is still a network error
                next
              end
            end
            # Cached asset — log headers/type/size but skip the (boring) body.
            trace_network(method, target, cache_entry.status, headers, body, cache_entry.headers, nil, t0, false)
            return response_hash(cache_entry.status, cache_entry.headers, cache_entry.body, target, redirected, body_raw: body_raw, cached: 'cache', encoded: cache_entry.encoded)
          end
          # only-if-cached forbids the network: no usable stored response → a network error.
          return nil if cache_mode == 'only-if-cached'

          env = rack_env_for(target, method: method, input: body || '')
          env['REQUEST_METHOD'] = method   # env_for upcases the method; restore the exact case (open-method-case-sensitive)
          # env_for always sets Content-Length to the input bytesize (0 for an empty body).
          # Fetch adds Content-Length: 0 for a bodyless request ONLY when the method is
          # POST or PUT; GET/HEAD and every other method (incl. a custom one like `Chicken`)
          # send no Content-Length when the body is empty (send-entity-body-none;
          # request-headers custom-method). A non-empty body keeps its real length.
          env.delete('CONTENT_LENGTH') if body.to_s.empty? && !%w[POST PUT].include?(method.to_s.upcase)
          apply_request_headers(env, headers) if headers
          apply_request_headers(env, @@asset_cache.revalidation_headers(cache_entry)) if cache_entry
          # The Referer follows the request's Referrer-Policy (a redirect response can
          # override the policy for the next hop — see below). `hop_referer` also becomes
          # the source the NEXT hop strips from.
          hop_referer = compute_referrer(ref_policy, ref_source, target)
          # The ancestor-chain cookie verdict (a SW-re-fetched navigation into a frame
          # with a cross-site ancestor): flag the env BEFORE cookies attach so the
          # SameSite gate in apply_default_request_env sees it, like a navigation would.
          env['csim.cookie_cross_site'] = true if cookie_cross_site
          apply_default_request_env(env, referer: hop_referer, force: false)
          # Whether this hop is cross-origin (cors only): a tainted (opaque) origin is
          # cross-origin to every real target; otherwise compare the target to the
          # document origin. Drives the Origin header, preflight, and the CORS check.
          cross_origin = cors && (effective_origin == 'null' || url_origin(target) != req_origin)
          # Fetch credentials mode decides cookie attachment, independent of the CORS
          # mode: `omit` never sends them; `include` always does; `same-origin` (default)
          # sends them only to a same-origin target — so an uncredentialed cross-origin
          # hop (cors OR no-cors) must not leak the document's cookies
          # (cors-redirect-credentials / cors-cookies). A navigation / internal caller has
          # no doc_origin, so it counts as same-origin and keeps them.
          hop_cross_origin = !!(doc_origin && (effective_origin == 'null' || url_origin(target) != doc_origin))
          send_cookies     = credentials == 'include' || (credentials != 'omit' && !hop_cross_origin)
          env.delete('HTTP_COOKIE') unless send_cookies
          # HTTP auth caching (RFC 7617 §2.2): once credentials succeed for an origin (cached below),
          # the UA sends them pre-emptively for later credentialed requests to it — so a Basic-auth
          # resource loads without a fresh 401 challenge (the login helper authenticates first, then
          # the guarded image/XHR requests carry the cached header). Gated on the same credential
          # decision as cookies; the caller's own Authorization (an explicit user:pass) always wins.
          # Skip the pre-emptive cache when THIS request brought its own challenge credentials (open()
          # user/pass) — those must win over a cached session, so the request goes out unauthenticated
          # and the 401-retry below applies the caller's credentials, not a stale cached pair
          # (send-authentication-competing-names-passwords).
          if send_cookies && !env.key?('HTTP_AUTHORIZATION') && !challenge_authz && (cached = @auth_cache[url_origin(target)])
            env['HTTP_AUTHORIZATION'] = cached
          end
          # A CORS request to a URL carrying credentials (`user:pass@`) is a network
          # error (access-control-and-redirects "user info" subtest).
          return nil if cross_origin && url_has_userinfo?(target)
          # CORS-preflight, re-evaluated PER HOP: a cross-origin non-simple request (a
          # non-safelisted method / header / Content-Type) must pass an OPTIONS preflight
          # first — so a same-origin request redirected cross-origin to an unsafe resource
          # is preflighted on the NEW origin (send-redirect-to-cors), not just an initially
          # cross-origin one (access-control-basic-get-fail-non-simple / preflight-*).
          if cross_origin && cors_unsafe_request?(method, headers)
            return nil unless cors_preflight_ok?(target, method, headers, effective_origin, with_credentials, hop_referer)
          end
          # Send the (effective) Origin — the UA owns this header — on a cors request when
          # the hop is cross-origin OR the method is not GET/HEAD (Fetch appends Origin to
          # every non-GET/HEAD request, so a same-origin POST carries it too). After a
          # cross-origin redirect the origin is the opaque "null".
          if cross_origin || (req_origin && !%w[GET HEAD].include?(method.to_s.upcase))
            env['HTTP_ORIGIN'] = effective_origin
          end
          # Fetch-Metadata request headers — emitted for every fetch/XHR/SW request (a mode is set;
          # the nil-mode internal callers — ESM / asset GET / beacon — are left alone). Sec-Fetch-Site
          # widens across the redirect chain vs the loop-invariant `sec_initiator` (see above). -Mode
          # is the request mode (a SW's `fetch(event.request)` re-issues a 'navigate'-mode request,
          # `new Request(…,{mode})` a 'same-origin' one); -Dest is 'empty' for a script-initiated
          # fetch — INCLUDING a SW's navigate-mode passthrough: navigation-headers.https pins
          # that a `fetch(event.request)` re-fetch reports `sec-fetch-dest: empty`, not the
          # navigation's destination. The navigation's dest ('document'/'iframe', threaded as
          # `nav_dest`) still drives the SameSite Lax gate below, which is top-level-only.
          if cors_mode
            # (…an opaque-origin client's request is of no site at all: cross-site, wherever it goes)
            sec_site = widen_sec_fetch_site(sec_site, client_origin == 'null' ? 'cross-site' : sec_fetch_site(sec_initiator, target))
            env['HTTP_SEC_FETCH_SITE'] = sec_site
            env['HTTP_SEC_FETCH_MODE'] = cors_mode
            # (…a document's own navigation request its destination: a SW's passthrough re-fetch alone reports 'empty')
            env['HTTP_SEC_FETCH_DEST'] = navigation ? nav_dest.to_s : 'empty'
            # (…and whether it is a top-level navigation's, which may set a SameSite cookie however cross-site:
            # merge_set_cookie)
            env['csim.cookie_top_level'] = true if cors_mode == 'navigate' && nav_dest.to_s == 'document'
          end
          # SameSite re-filter: cookies attached above (apply_default_request_env ran before this hop's site was known) —
          # a cross-site hop sheds Strict/Lax cookies. The COOKIE site is not always the Sec-Fetch latch: a `navigate`-mode
          # request is a SW re-issuing the navigation it intercepted, which keeps the CHAIN's verdict (and the top-level
          # Lax exception for a GET) — any other is judged by its client (`widen_cookie_site`: an SW that builds a
          # `new Request` fetches as ITSELF — same-site-cookies expects Strict cookies on the rewritten same-origin request
          # even though the intercepted navigation was cross-site).
          if cors_mode == 'navigate'
            cookie_site = sec_site
          else
            widen_cookie_site.(target)
          end
          if cookie_site
            # The ancestor-chain verdict (a SW re-fetch of a navigation into a frame with a cross-site ancestor — see
            # frame_ancestor_cross_site?) overrides: it's a property of the target frame, cross-site whoever issues it.
            cookie_site = 'cross-site' if cookie_cross_site
            # (…the one verdict the response's Set-Cookie is stored by too: merge_set_cookie)
            env['csim.cookie_site'] = cookie_site
            if env['HTTP_COOKIE'] && cookie_site == 'cross-site'
              # The Lax navigation exception is TOP-LEVEL only (dest 'document'): an iframe navigation or an
              # ancestor-cross frame navigation (cookie_cross_site) sheds Lax like any cross-site subresource.
              lax_ok = cors_mode == 'navigate' && method.to_s.upcase == 'GET' && nav_dest.to_s == 'document' && !cookie_cross_site
              ck = cookie_header_for(env_request_url(env), secure: env_secure_channel?(env), cross_site: true, lax_ok: lax_ok)
              ck.empty? ? env.delete('HTTP_COOKIE') : env['HTTP_COOKIE'] = ck
            end
          end
          if env_extras
            env.merge!(env_extras)
            # (…and the env it went with, where the caller asked something of the request's: a hijacked fetch's cookie
            # context, which its later response is stored by)
            Thread.current[:csim_fetch_env] = env
          end
          response = dispatch_rack_or_http(target, env, method: method, body: body) or return nil
          status, resp_headers, resp_body = response
          Thread.current[:csim_fetch_server_delay_ms] += server_delay_ms_of(resp_headers)
          # Transparent HTTP Basic auth (RFC 7617): a request carrying CHALLENGE credentials (open()
          # user/pass / URL userinfo) that gets a 401 "Basic" challenge — and hasn't already sent an
          # Authorization (an explicit setRequestHeader / a pre-emptively-attached cached credential) —
          # is re-sent ONCE with them; only the authenticated response reaches script, the 401 never does
          # (send-authentication-basic / -existing-session). `omit` sends no credentials at all.
          answered = challenge_authz && status.to_i == 401 && credentials != 'omit' &&
                     !env.key?('HTTP_AUTHORIZATION') && www_authenticate_basic?(resp_headers)
          if answered
            resp_body.close if resp_body.respond_to?(:close)
            env['HTTP_AUTHORIZATION'] = challenge_authz
            response = dispatch_rack_or_http(target, env, method: method, body: body) or return nil
            status, resp_headers, resp_body = response
          end
          # Fetch credentials mode "omit" ignores credentials the response sends back too —
          # its Set-Cookie is dropped, not stored (cors-cookies / credentials "omit mode").
          merge_set_cookie(resp_headers, target, env) unless credentials == 'omit'
          # Cache the challenge credential the 401-retry above just supplied, where the origin ACCEPTED it
          # (no 401 again), for the pre-emptive send above — an authentication entry exists only once a
          # challenge was answered (Fetch "HTTP-network-or-cache fetch"; Chrome sends nothing pre-emptively
          # for credentials a server never asked for, measured). Only the request's OWN origin is cached:
          # Authorization is stripped on a cross-origin redirect hop (above), so origin A's credentials
          # can't seed origin B's cache. (A non-2xx same-origin response — an opaque status-0 no-cors
          # fetch, a same-origin 3xx — still establishes them, so the gate is "not a 401", not "is a 2xx".)
          @auth_cache[url_origin(target)] = challenge_authz if answered && status.to_i != 401
          if status == 304 && cache_entry
            trace_network(method, target, cache_entry.status, headers, body, cache_entry.headers, nil, t0, false)
            resp_body.close if resp_body.respond_to?(:close)
            @@asset_cache.refresh(target, cache_entry, resp_headers)
            # The cache stores the RAW response headers, so a cross-origin cached entry must
            # be re-filtered through the CORS exposed-header set on the way back to script —
            # a 304 revalidation must not leak headers the original cross-origin fetch hid.
            cached_headers = cross_origin ? cors_exposed_headers(cache_entry.headers, with_credentials) : cache_entry.headers
            return response_hash(cache_entry.status, cached_headers, cache_entry.body, target, redirected, body_raw: body_raw, cached: 'validated', raw_headers: cache_entry.headers, encoded: cache_entry.encoded)
          end
          # Fetch "CORS check" runs on EVERY cross-origin response — including a 3xx the
          # UA is about to follow (a redirect whose response lacks a valid Access-Control
          # -Allow-Origin is itself a network error: access-control-and-redirects). A
          # credentialed request additionally forbids `*` and needs Allow-Credentials.
          if cross_origin && !cors_response_ok?(resp_headers, effective_origin, with_credentials)
            resp_body.close if resp_body.respond_to?(:close)
            return nil
          end
          # A redirect-status response in a NON-follow mode is handled without following,
          # keyed on the status ALONE (the Location is never parsed): `error` is a network
          # error; `manual` is an opaque-redirect filtered response (status 0, empty
          # statusText/headers, the ORIGINAL request URL, type 'opaqueredirect'). The CORS
          # check above runs first, so a cross-origin redirect that fails CORS is a network
          # error either way (redirect-mode / -location).
          if redirect_mode != 'follow' && REDIRECT_STATUSES.include?(status.to_i)
            if redirect_mode == 'error'
              resp_body.close if resp_body.respond_to?(:close)
              raise StandardError, '[capybara-simulated] fetch: redirect blocked by redirect=error mode'
            end
            # A no-cors request may not even opaquely expose a CROSS-origin redirect — a
            # no-cors non-follow redirect to a cross-origin target is a network error,
            # while a same-origin one still yields an opaque-redirect.
            if no_cors_mode && crossed
              resp_body.close if resp_body.respond_to?(:close)
              return nil
            end
            # The render bytes must be the DECODED body (like the terminal hop below) — a
            # no-Location 3xx served with Content-Encoding otherwise commits gzip bytes
            # as the document when a navigation renders them.
            return opaque_redirect_hash(target, status, resp_headers, decode_content_encoding(read_rack_body(resp_body), resp_headers))
          end
          if (loc = redirect_location(status, resp_headers))
            # Log this hop (3xx) before method/body are rewritten for the next.
            trace_network(method, target, status, headers, body, resp_headers, nil, t0, true)
            # Cache the redirect itself (a cacheable 3xx with freshness) BEFORE following it —
            # the follow does `next`, which would otherwise skip the store below — so a later
            # only-if-cached / force-cache request can follow the redirect chain from the cache
            # (request-cache "uses cached … redirects"). Same store gate as the terminal hop.
            @@asset_cache.store(target, status, resp_headers, '') if method == 'GET' && cache_mode != 'no-store' && !skip_cache
            redirected = true
            ref_source = hop_referer   # the next hop strips from what THIS hop sent
            # A redirect response's Referrer-Policy overrides the policy for the next hop
            # (redirect-referrer-override): the last valid token of the header wins.
            if (rp = header_field(resp_headers, 'referrer-policy'))
              tok = Array(rp).join(',').split(',').map(&:strip).reverse.find {|t| REFERRER_POLICIES.include?(t) }
              ref_policy = tok if tok
            end
            next_url = resolve_against(loc, target)
            # The UA only follows http(s) redirects: a Location that resolves to a
            # non-HTTP(S) URL (data:, an `invalidurl:` scheme, …) is a network error
            # (redirect-location data/invalid in follow mode).
            unless next_url.to_s.match?(%r{\Ahttps?://}i)
              resp_body.close if resp_body.respond_to?(:close)
              return nil
            end
            # A cross-origin redirect taints the request's origin to opaque ("null") only
            # once the request was ALREADY cross-origin (response tainting "cors", i.e.
            # `crossed`) and the hop changes origin — so a subsequent hop sends Origin: null
            # and the CORS check demands the server allow "null"/"*". The FIRST cross-origin
            # hop out of a same-origin request keeps the real origin (redirect-origin
            # "same origin to other origin" sends the document origin, not null).
            effective_origin = 'null' if cors && crossed && url_origin(next_url) != url_origin(target)
            # Fetch "HTTP-redirect fetch": a CROSS-ORIGIN redirect strips the request's
            # `Authorization` — credentials sent to the first origin must not be replayed to a
            # different one (nor seed that origin's auth cache below).
            if url_origin(next_url) != url_origin(target) && headers.is_a?(Hash)
              headers = headers.reject {|k, _| k.to_s.casecmp?('authorization') }
            end
            target = carry_fragment(target, next_url)
            if bad_port?(target)   # a redirect to a blocked port is a network error too
              resp_body.close if resp_body.respond_to?(:close)
              return nil
            end
            # Fetch "HTTP-redirect fetch": the method changes to GET (dropping the
            # body + its Content-* headers) ONLY for 301/302 of a POST, or 303 of a
            # non-GET/HEAD. Otherwise method, body, and headers are preserved — so a
            # GET/HEAD redirected via 301/302/303 keeps its method and Content-Type,
            # and 307/308 always preserve (xhr send-redirect basics).
            up = method.to_s.upcase
            if Native.redirect_to_get(status.to_i, up)
              method  = 'GET'
              body    = nil
              headers = headers.reject {|k, _| REDIRECT_DROPPED_HEADERS.include?(k.to_s.downcase) } if headers.is_a?(Hash)
            end
            resp_body.close if resp_body.respond_to?(:close)
            next
          end
          # A follow-mode redirect whose Location header IS present but EMPTY parses to the
          # request URL — a self-redirect that would loop until the redirect limit trips a
          # network error. redirect_location returns nil for it (empty ⇒ no followable
          # target, so navigation keeps rendering the 3xx), so recognize it here and fail
          # directly — fetch-only (redirect-empty-location follow mode).
          if REDIRECT_STATUSES.include?(status.to_i)
            raw_loc = location_field(resp_headers)
            if raw_loc && raw_loc.to_s.empty?
              resp_body.close if resp_body.respond_to?(:close)
              return nil
            end
          end
          # (…a body the wire cut short read as far as it came, and then fails — no response the cache keeps)
          cut_short = resp_body.is_a?(CutShortBody)
          body_str  = read_rack_body(resp_body)
          # A HEAD response, and a null-body status (204/205/304), have NO body — the UA
          # discards whatever the server sent and exposes response.body as null
          # (response-method HEAD; response-null-body). `null_body` flags it so the JS
          # Response reports a null body + empty text.
          null_body = method.to_s.upcase == 'HEAD' || NULL_BODY_STATUSES.include?(status.to_i)
          body_str = '' if null_body
          # The UA transparently decodes a Content-Encoding'd body (gzip/deflate); the
          # header stays, the bytes are inflated (response-data-gzip / -deflate). The size on
          # the wire is what Resource Timing's `encodedBodySize` reports.
          encoded_size = body_str.bytesize
          body_str = decode_content_encoding(body_str, resp_headers)
          # A cross-origin response only EXPOSES (getResponseHeader / getAllResponseHeaders)
          # the CORS-safelisted response headers plus those named in Access-Control-Expose
          # -Headers (`*` = all). content-type stays safelisted, so response decoding is
          # unaffected. (Filtered for script exposure only — trace / set-cookie / cache see
          # the full set.) The CORS check itself already ran above (incl. on 3xx hops).
          # The virtual server delay is EPHEMERAL processing time (accumulated across the preflight +
          # every redirect hop): the client reads the TOTAL to time its async deferral, but it must
          # never be cached or replayed on a cache hit — strip it from the traced/stored response and
          # expose the total to the CLIENT only (added after CORS filtering, so it always survives).
          total_delay      = Thread.current[:csim_fetch_server_delay_ms].to_i
          resp_headers      = resp_headers.reject {|k, _| k.to_s.casecmp?('x-csim-server-delay-ms') }
          exposed_headers   = cross_origin ? cors_exposed_headers(resp_headers, with_credentials) : resp_headers
          exposed_headers   = exposed_headers.merge('X-Csim-Server-Delay-Ms' => total_delay.to_s) if total_delay > 0
          trace_network(method, target, status, headers, body, resp_headers, body_str, t0, false)
          # A no-store request must not write the cache (RFC 9111 §5.2.1.5); a request carrying
          # the author's own conditional bypasses the UA cache entirely (read AND write) — it's
          # "treated similarly to no-store" (request-cache-default-conditional). Every other mode
          # (incl. reload, which refreshes it) stores a cacheable GET response.
          @@asset_cache.store(target, status, resp_headers, body_str, encoded: encoded_size) if method == 'GET' && cache_mode != 'no-store' && !skip_cache && !cut_short
          # A no-cors cross-origin response is OPAQUE: status 0, empty body, no exposed
          # headers, empty URL (cors-basic "Opaque filter"). Otherwise the type is 'cors'
          # for a cross-origin (CORS-allowed) response, else 'basic'.
          return response_hash(0, {}, '', '', false, type: 'opaque', body_null: true, opaque_render: body_str, encoded: encoded_size) if no_cors_mode && crossed
          return response_hash(status, exposed_headers, body_str, target, redirected, type: crossed ? 'cors' : 'basic', body_null: null_body, body_cut_short: cut_short, body_raw: body_raw, encoded: encoded_size, raw_headers: resp_headers)
        end
        raise StandardError, "[capybara-simulated] fetch exceeded #{MAX_FETCH_REDIRECTS} redirects"
      rescue StandardError => e
        warn "[capybara-simulated] rack_fetch failed: #{e.class}: #{e.message[0, 200]}"
        nil
      end

      # Cap per-body capture so one big asset/response can't bloat the
      # trace. Generous (this is a local debugging artifact).
      NETWORK_BODY_CAP = 256 * 1024

      # Enriched network log for the trace: response content-type / byte
      # size / elapsed ms / redirect flag, plus request + response headers
      # and bodies (devtools-style). No-ops — and skips all the lookups —
      # unless a trace is recording, so the fetch hot path is unaffected
      # when tracing is off.
      def trace_network(method, url, status, req_headers, req_body, resp_headers, resp_body, t0, redirected)
        return unless @trace
        ct = header_field(resp_headers, 'content-type')
        ct = header_text(ct).split(';', 2).first&.strip if ct   # "" → split is [] → first is nil
        size = if resp_body
                 resp_body.bytesize
               elsif (cl = header_field(resp_headers, 'content-length'))
                 header_text(cl).to_i
               end
        log_network(method, url, status,
                    content_type:     (ct if ct.is_a?(String)),
                    size:             size,
                    duration_ms:      (t0 && ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0) * 1000).round),
                    redirected:       (redirected || nil),
                    request_headers:  normalize_trace_headers(req_headers) {|v| Array(v).join(', ') },
                    request_body:     (req_body && !req_body.to_s.empty? ? cap_trace_body(req_body) : nil),
                    response_headers: normalize_trace_headers(resp_headers) {|v| header_text(v) },
                    response_body:    (resp_body ? cap_trace_body(resp_body) : nil))
      rescue StandardError => e
        # A trace-logging bug must NEVER break the real fetch: rack_fetch's
        # own `rescue StandardError` would otherwise swallow it and return
        # nil, so the asset (e.g. jQuery) silently fails to load. Drop the
        # log entry instead.
        warn "capybara-simulated: trace network log failed: #{e.class}: #{e.message}"
      end

      # JSON-safe body for the trace: binary (non-UTF-8) bodies become a
      # placeholder rather than mojibake, and long bodies are truncated
      # (scrubbed so a mid-codepoint cut can't yield invalid UTF-8).
      #
      # Rack response bodies are ASCII-8BIT (BINARY); reinterpret the bytes as
      # UTF-8 up front and keep working in UTF-8 throughout. Otherwise a body
      # whose bytes ARE valid UTF-8 but stays BINARY-tagged would flow out of
      # here still BINARY, and the first concat with a UTF-8 string (the
      # truncation marker here, or the trace-buffer / JSON serialization
      # downstream) raises Encoding::CompatibilityError on any byte ≥ 0x80.
      def cap_trace_body(body)
        s = body.to_s.dup.force_encoding('UTF-8')
        return "[binary, #{s.bytesize} bytes]" unless s.valid_encoding?
        s.bytesize > NETWORK_BODY_CAP ? (s.byteslice(0, NETWORK_BODY_CAP).scrub + "\n…[truncated, #{s.bytesize} bytes total]") : s
      end

      # Each of the headers as one line of text, which the block reads: a request's are the page's text already, a
      # response's are the server's bytes.
      def normalize_trace_headers(headers)
        return nil unless headers
        headers.each_with_object({}) do |(k, v), out|
          # `x-csim-status-text` is an internal sentinel carrying the HTTP reason
          # phrase (response_hash lifts it into statusText); it's never a real wire
          # header, so keep it out of the trace.
          next if k.to_s.downcase == 'x-csim-status-text'
          out[k.to_s] = yield(v)
        end
      end

      # CGI convention: `Content-Type` and `Content-Length` land in env
      # *without* the HTTP_ prefix. Rails / Rack params parsing reads
      # `CONTENT_TYPE` and dispatches JSON / multipart parsers off it;
      # sending it as `HTTP_CONTENT_TYPE` lets the request through but
      # with the default `text/plain`, so JSON bodies from
      # `@rails/request.js` never deserialise and the server reads an
      # empty params hash.
      def apply_request_headers(env, headers)
        # Preserve the author's exact header names (casing + token chars) alongside the
        # CGI-mangled HTTP_* keys: the Rack env upcases names and drops non-alphanumerics
        # (Status-URI → HTTP_STATUS_URI, a tchar-only name → an unrecoverable key), but a
        # .py echo handler (inspect-headers / echo-headers) reports the names verbatim.
        # run_py_handler reads this side list to emit the original names.
        raw = (env['csim.raw_request_headers'] ||= []) if @@capture_raw_request_headers
        headers.each {|k, v|
          raw << [k.to_s, v.to_s] if raw
          name = k.to_s.upcase.tr('-', '_')
          case name
          when 'CONTENT_TYPE', 'CONTENT_LENGTH' then env[name] = v.to_s
          else env["HTTP_#{name}"] = v.to_s
          end
        }
      end

      # Content types whose pure-ASCII bytes ARE the UTF-8 `body` text
      # that ships back to JS, so `body_bytes` (the bytes a second time)
      # is left off for them — the dominant app JSON / HTML traffic.
      # Anything else (images, octet-stream, gzipped traineddata, a
      # non-ASCII text body) carries `body_bytes`; `fetch.js` and
      # `xhr.js` both fall back to the text body when it is absent.
      TEXT_CONTENT_TYPE_PREFIXES = %w[text/ application/json application/javascript application/ecmascript application/xml image/svg+xml].freeze

      # `body_raw: true` is for a host-side BINARY consumer (an <img> / @font-face load
      # that decodes the bytes here and never shows them to script): the bytes ride
      # `body_raw` untouched and the text decode is skipped — it would be pure waste on
      # a path that runs for EVERY image load.
      def response_hash(status, headers, body, url, redirected, type: 'basic', body_null: false, body_cut_short: false, opaque_render: nil, body_raw: false, cached: nil, encoded: nil, raw_headers: nil)
        raw     = body.to_s
        hdrs    = stringify(headers)
        # Resource Timing's sizes: the decoded body, the body on the wire (before a
        # Content-Encoding was undone), and whether the HTTP cache served it — fresh
        # (`'cache'`: nothing crossed the wire) or after a 304 (`'validated'`: headers did) —
        # plus the three headers its checks read from the UNFILTERED response (a cross-origin
        # fetch exposes only the CORS-safelisted headers to script, and none of these is).
        timing  = {'bytes' => raw.bytesize, 'encoded' => encoded || raw.bytesize, 'cached' => cached}
        # (…a body the wire cut short: what came, and then a network error as the page reads it)
        timing['body_error'] = true if body_cut_short
        (raw_headers || headers).each do |k, v|
          case k.to_s.downcase
          when 'timing-allow-origin' then timing['tao'] = header_text(v)
          when 'server-timing'       then timing['serverTiming'] = header_text(v)
          when 'content-encoding'    then timing['contentEncoding'] = header_text(v)
          end
        end
        # A NUL in a header value is not a valid HTTP message; a real server can't
        # put it on the wire, so the fetch is a network error (nil → status 0 / a
        # thrown NetworkError for a sync XHR). See headers-normalize-response.
        return nil if hdrs.any? {|_, v| v.include?("\u0000") }
        if body_raw
          return timing.merge(
            'status'     => status,
            'statusText' => '',
            'headers'    => hdrs,
            'body'       => '',
            'body_raw'   => raw.b,
            'url'        => url,
            'redirected' => redirected,
            'type'       => type
          )
        end
        is_text = text_response?(hdrs)
        # `body` crosses as TEXT — `responseText` semantics: the bytes decoded
        # as UTF-8 with invalid sequences replaced (a leading BOM selects the
        # encoding per the HTML "decode" algorithm and is removed). The real
        # bytes for binary consumers ride `body_bytes`; the Rack body arrives
        # BINARY-tagged (see `RuntimeShared.utf8_text`).
        text = RuntimeShared.utf8_text(is_text ? decode_response_bom(raw) : raw)
        # statusText = the HTTP reason phrase: a custom one carried on the internal
        # x-csim-status-text header (status.py), else the status code's standard
        # reason (xhr status/statusText tests). Strip the internal header either way.
        custom_reason = hdrs.delete('x-csim-status-text')
        # Rack::Utils::HTTP_STATUS_CODES values are ASCII-8BIT (binary) strings — the V8
        # bridge marshals a binary string as a byte array, not a JS string, so statusText
        # would arrive as [79,75] instead of "OK" (abort-during-loading reads statusText
        # on a static-file response). utf8_text re-tags + scrubs to a clean JS string, the
        # same path the body and every header value already take.
        reason = RuntimeShared.utf8_text(custom_reason || Rack::Utils::HTTP_STATUS_CODES[status.to_i] || '')
        # HTTP/2 has no reason phrase, so statusText is always the empty string there (a WPT
        # `.h2` test document's fetches run over h2). We don't model the h2 transport, so key
        # off the document URL — the same signal WPT uses to serve the resource over h2
        # (fetch/xhr status.h2 "statusText over H2 … should be the empty string").
        reason = '' if @current_url.to_s.include?('.h2.')
        out = timing.merge(
          'status'     => status,
          'statusText' => reason,
          'headers'    => hdrs,
          'body'       => text,
          'url'        => url,
          'redirected' => redirected,
          'type'       => type
        )
        out['body_null'] = true if body_null   # null-body status / HEAD → response.body is null
        # Hand the raw bytes to the (XHR) client UNLESS the response is pure-ASCII text.
        # ASCII decodes identically under every encoding — so responseText is already
        # correct from the UTF-8 `body`, and it round-trips byte-for-byte as an
        # ArrayBuffer/Blob. Any NON-ASCII body needs the bytes: a non-UTF-8 charset or an
        # XML-prolog / <meta charset>-sniffed encoding (responseText), or multibyte UTF-8
        # read as arraybuffer/blob — the client decodes them with the final encoding
        # (decodeResponseBytes). `ascii_only?` is a cheap C-level scan, so the dominant
        # pure-ASCII app JSON/HTML traffic keeps the fast path and ships the body once.
        # BINARY-tagged, the bytes reach JS as a Uint8Array.
        out['body_bytes'] = raw.b unless is_text && raw.ascii_only?
        # An OPAQUE (no-cors cross-origin) response hides its body from every script-visible read
        # (body/body_bytes are empty). But the bytes are still needed to RENDER an <img> the response
        # backs (a cross-origin image displays, merely canvas-tainting) — carry them on a private
        # side channel the image decode path reads, never a public body accessor. Attached to EVERY
        # opaque response, not just image requests: this is `rack_fetch`, which has no request
        # destination (a SW's own no-cors `fetch()` doesn't know its eventual consumer is an <img>),
        # so the choice is made client-side. The bytes are already in memory (`body_str`).
        out['opaque_render'] = opaque_render.b if opaque_render && !opaque_render.empty?
        out
      end

      # An opaque-redirect filtered response (redirect mode 'manual'): status 0, empty
      # headers, hidden body — that's all script may see. A NAVIGATION consuming it must
      # still process the REAL redirect the filter hides (a controlled frame's SW does
      # `respondWith(fetch(new Request(url, {redirect: 'manual'})))` and the navigation
      # follows the Location — or, a redirect-status response with NO Location, commits
      # the body as the document, as Chrome does). The unfiltered values ride private
      # wire fields no public accessor reads (the `opaque_render` pattern), so they
      # survive the SW respondWith wire and a Cache put/match round-trip
      # (serializeResponseWire copies them from `_raw`). Consumed by the navigation
      # normalization in service_worker_navigation_fetch.
      private def opaque_redirect_hash(target, status, resp_headers, body_str)
        o_r = response_hash(0, {}, '', target, false, type: 'opaqueredirect', body_null: true)
        o_r['redirect_status'] = status.to_i
        if (loc = redirect_location(status, resp_headers))
          o_r['redirect_loc'] = resolve_against(loc, target)
        else
          o_r['redirect_ct']       = header_text(header_field(resp_headers, 'content-type'))
          o_r['opaque_render'] = body_str.to_s.b unless body_str.to_s.empty?
        end
        o_r
      end

      # A document as `__csimLoadDocument` takes it: its BYTES (BINARY-tagged, a Uint8Array to V8), decoded as it loads
      # by HTML's encoding sniffing — or, with none, the empty string: about:blank and a blank response are UTF-8.
      def document_payload(bytes)
        bytes.to_s.empty? ? '' : bytes.to_s.b
      end

      # A text body with its byte-order mark taken off and followed: UTF-8 text for a UTF-8 or UTF-16 BOM, the
      # bytes as they are without one (the hot path: a 2–3 byte prefix check). One BOM is consumed; any further
      # ones are ordinary U+FEFF characters in the text.
      def decode_response_bom(s)
        b = s.b
        if b.start_with?("\xEF\xBB\xBF".b)
          b.byteslice(3..)
        elsif b.start_with?("\xFF\xFE".b) || b.start_with?("\xFE\xFF".b)
          # Generic UTF-16: the BOM picks endianness and is dropped by the decoder. Malformed units are replaced
          # rather than raised (a truncated / odd-length body still reads). A UTF-32LE BOM (FF FE 00 00) is read
          # as UTF-16LE's, as browsers read it (UTF-32 is no encoding of theirs).
          b.force_encoding(Encoding::UTF_16).encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
        else
          s
        end
      rescue StandardError
        s
      end

      def text_response?(headers)
        ct = header_text(header_field(headers, 'content-type')).downcase
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

      # Transparently decode a Content-Encoding'd response body (HTTP "content coding"):
      # gzip / x-gzip via Zlib.gunzip; deflate via zlib-wrapped inflate, falling back to
      # raw DEFLATE (the "deflate" coding is ambiguously used for both). Unknown codings
      # (e.g. br) and malformed data are left untouched — best-effort, like a browser that
      # would error, but we keep the bytes so the caller still sees a response.
      def decode_content_encoding(body, headers)
        return body if body.nil? || body.empty?
        raw = headers.find {|k, _| k.to_s.downcase == 'content-encoding' }&.last
        enc = (raw.is_a?(Array) ? raw.join(',') : raw.to_s).strip.downcase   # Rack 3 may hand the value as an array
        # The decoded bytes re-enter the UTF-8 text pipeline the same as an
        # un-encoded body (read_rack_body yields UTF-8), so re-tag them — Zlib
        # output is ASCII-8BIT, which would otherwise marshal to V8 as a byte array.
        decoded =
          case enc
          when 'gzip', 'x-gzip' then Zlib.gunzip(body.b)
          when 'deflate'
            begin
              Zlib::Inflate.inflate(body.b)
            rescue Zlib::Error
              Zlib::Inflate.new(-Zlib::MAX_WBITS).inflate(body.b)   # raw (header-less) DEFLATE
            end
          else return body
          end
        decoded.force_encoding('UTF-8')
      rescue Zlib::Error
        body
      end

      # Defer the navigation: doing it from inside the running V8 call
      # would dispose the Context mid-call. tick_real_time drains
      # after the call returns. Same pattern as a planned submission (navigation_plan.rs).
      # (…`replace`: a `location.replace`, whose navigation replaces the current history entry rather than adding one)
      # …navigated by the top-level document's own script, or (`initiator_realm`) by a frame's — `open(url, '_top')`, a
      # `_top` link — its Referer that frame's document under the policy a link sets (`policy`), taken now: the frame may
      # be gone by the time the navigation runs (HTML: the source document the navigation's, snapshotted as it begins).
      def location_assign(url, replace: false, initiator_realm: nil, policy: '')
        @pending_location           = resolve_against_current(url.to_s)
        @pending_location_replace   = replace
        @pending_location_initiator = initiator_realm && [initiator_realm.to_i, navigation_referrer(initiator_realm.to_i, policy)]
      end
      # The Referer of a navigation the document of realm `realm` makes, `[url, policy]`: its document's policy, or the one
      # a link sets (`policy`) — which no link lifts for a document of an opaque origin: it refers as none, a step before
      # any policy.
      def navigation_referrer(realm, policy = '')
        source, document_policy = realm_referrer_initiator(realm)
        policy = '' if frame_document_origin_opaque?(realm)
        [source, policy.to_s.empty? ? document_policy : policy.to_s]
      end
      # …and none — nor a reload: a navigation the page planned since (a location's, a link's, a form's, a reload) replaces
      # it (HTML "plan to navigate": the later is the one taken).
      def cancel_planned_navigation
        @pending_location = nil
        @pending_reload   = nil
        # (…a frame's submission to the page as well, which was the page's navigation planned last: `frame_submit_self`)
        @pending_page_submission = nil
      end
      def consume_pending_location
        return unless (url = @pending_location)
        # (…its replace flag and initiator taken with it: a location the page plans after it is its own)
        replace, initiator = @pending_location_replace, @pending_location_initiator
        @pending_location = @pending_location_replace = @pending_location_initiator = nil
        # (…a `blob:` URL's blob the one the navigation began with, which the page's plan holds: location.js `dispatchNav`)
        blob = host_blob(@runtime.call('__csimTakeLocationBlob', url)) if url.match?(/\Ablob:/i)
        # The page's `location` navigates the page, whichever realm's script set it — a frame's own is its container's to
        # navigate (location.js `dispatchNav`), an entered one's too — each judged against the document it navigates.
        in_top_context do
          # A `location.href`/`assign`/`hash` set to a same-document fragment (e.g. `location.hash = ''`) is NOT a
          # document fetch — move the hash without rebuilding the VM, matching the anchor-click navigate branch. Without
          # this a hash assignment reloaded the page, discarding all JS state.
          if pure_fragment_navigation?(url)
            update_current_hash(url)
          elsif url.match?(/\Adata:/i)
            # A navigation of the top-level browsing context to a `data:` URL: Chrome and Firefox refuse it (the URL's
            # document would run with no origin of its own).
            nil
          elsif initiator
            realm, referrer = initiator
            navigate_top_from(realm, referrer, url, replace: replace, blob: blob)
          else
            from_document(0) { navigate(url, replace: replace, blob: blob) }
          end
        end
      end
      # A nested browsing context navigating its OWN `location` (the frame's
      # `location.href`/assign/replace/`location=`, incl. cross-frame
      # `iframe.contentWindow.location.href = …`). `realm_id` is the frame's realm.
      # Deferred like location_assign: applying it re-navigates the owning iframe,
      # which disposes that realm — illegal while the frame's location setter is
      # still on the V8 stack — so we stash and drain from `tick_real_time`.
      # …navigated by its own document, or (`initiator_realm`) by another's — a link whose target names it, under the
      # `policy` its own `rel` / `referrerpolicy` sets ('' none) — the referrer made of the initiator as it is followed,
      # before the drain: by then the initiator may have navigated itself.
      def frame_navigate_self(url, realm_id, initiator_realm = realm_id, policy = '')
        return if realm_id.nil? || realm_id.zero?
        # Keyed by realm id (last URL wins per frame) so two different frames each
        # navigating in one turn both apply — a single slot would drop one.
        supersede_frame_navigation(realm_id)
        (@pending_frame_nav ||= {})[realm_id] = [url.to_s, navigation_referrer(initiator_realm, policy), frame_sandbox_now(realm_id), initiator_realm]
      end
      # The `[attribute]` the frame-nav drain's navigation of frame realm `realm` carries (`frame_sandbox_now`), none for
      # another realm's — one the navigation's own made, nested in it.
      def navigation_sandbox(realm)
        sandbox_realm, sandbox = @navigation_sandbox
        sandbox if realm && sandbox_realm == realm.to_i
      end
      # The `sandbox` attribute frame realm `realm_id`'s container has as a navigation of it begins — what the document it
      # makes is sandboxed by, whatever the attribute says when the response is in — as `[attribute]` (its value, nil for
      # none), carried with the navigation to the document it makes; nil where there is no container to ask.
      def frame_sandbox_now(realm_id)
        parent = @runtime.frame_realm_parent(realm_id)
        handle = frame_container_handle(realm_id, parent)
        [frame_realm_host_call(parent, '__csimFrameSandboxAttribute', handle)] unless handle.zero?
      rescue StandardError
        nil
      end
      def consume_pending_frame_nav
        # Window-realm self-navs are realm navs too — drain them at every frame-nav
        # drain point (before the frame-nav early-return so a window-only nav lands).
        consume_pending_window_nav
        return if @pending_frame_nav.nil? || @pending_frame_nav.empty?
        navs = @pending_frame_nav
        @pending_frame_nav = nil
        navs.each do |realm_id, (url, referrer, sandbox, initiator)|
          invalidate_find_cache
          # (…sandboxed as the container said when the navigation began: what its document's seed and a download its
          # response is take, a document it does not make — a refused unload — leaving nothing behind)
          saved_sandbox, @navigation_sandbox = @navigation_sandbox, [realm_id, sandbox]
          # If this frame is on the entered `within_frame` stack, navigate it
          # through `navigate_frame` — it does the full fetch (redirects /
          # downloads / cookies) AND updates `@frame_stack` / `@current_realm_id`
          # so the enclosing `within_frame` block sees the new document. Otherwise
          # (a parent's `iframe.contentWindow.location.href = …`, a link whose target
          # names it) re-navigate the owning iframe by realm id — fetched here for an
          # http(s) URL, else by the src-reassignment path in the realm whose
          # document holds the iframe.
          # (…made by the initiator's document: what a download its response is may be saved by)
          from_document(initiator) do
            entry = @frame_stack.find {|e| e[:realm_id] == realm_id }
            if entry
              navigate_frame(url, entry: entry, referrer: referrer)
            elsif url.match?(%r{\Ahttps?://}i)
              # An absolute http(s) self-nav (`self.location = …` / link click) is fetched Ruby-side so
              # it carries correct navigation request headers (Referer under policy / Sec-Fetch);
              # non-http(s) and relative URLs stay on the JS src-reassignment path via
              # navigate_realm_self_get. `record: false` — a location/link frame nav isn't history-
              # recorded yet (that's a form-submission-only path), and must not push where a
              # location.replace should overwrite.
              navigate_realm_self_get(realm_id, url, record: false, referrer: referrer)
            else
              frame_realm_host_call(@runtime.frame_realm_parent(realm_id), '__csimNavigateFrameByRealm', realm_id, url, sandbox)
            end
          end
        rescue StandardError => e
          log_console('warn', "frame self-navigation failed: #{e.message}")
        ensure
          @navigation_sandbox = saved_sandbox
        end
      end
      # A same-origin WINDOW realm (window.open in this isolate) navigating itself
      # via `win.location = …`. Like frame_navigate_self, defer (the call lands here
      # from the realm's own location setter, mid-flight) and drain after the action.
      # A blob: URL is resolved to bytes NOW — before the opener's typical immediate
      # `revokeObjectURL` — since the realm reload happens later (url-in-tags-revoke).
      def window_realm_navigate_self(url, realm_id)
        return if realm_id.nil? || realm_id.zero?
        spec = {url: url.to_s}
        if url.to_s.start_with?('blob:') && (b = read_blob_for_window(url.to_s))
          spec[:body]  = document_payload(b[:bytes])
          spec[:ctype] = b[:type].to_s.empty? ? 'text/html' : b[:type]
        end
        (@pending_window_nav ||= {})[realm_id] = spec
      end
      def consume_pending_window_nav
        return if @pending_window_nav.nil? || @pending_window_nav.empty?
        navs = @pending_window_nav
        @pending_window_nav = nil
        navs.each do |realm_id, spec|
          invalidate_find_cache
          body, ctype = spec[:body], spec[:ctype]
          # http(s) / relative URL window-realm nav (rack fetch) is not modeled yet —
          # only the blob/in-memory document case (which pre-resolved bytes above)
          # loads here. Warn rather than silently drop so an unsupported popup
          # navigation is diagnosable instead of looking like a frozen about:blank.
          if body.nil?
            log_console('warn', "window-realm navigation to #{spec[:url]} not modeled (only blob: documents load); ignoring")
            next
          end
          @runtime.reload_window_realm(realm_id, spec[:url], body.to_s, ctype.to_s)
        rescue StandardError => e
          log_console('warn', "window realm self-navigation failed: #{e.message}")
        end
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
        @pending_reload = nil
        refresh
      end
      # `frame.contentWindow.location.reload()` from a nested browsing context.
      # Like `frame_navigate_self`, the JS side flags the initiating realm here
      # and we defer (so the child realm isn't disposed mid-reload()). Keyed by
      # realm id so two frames reloading in one turn both apply.
      def frame_reload_self(realm_id)
        return if realm_id.nil? || realm_id.zero?
        supersede_frame_navigation(realm_id)
        (@pending_frame_reload ||= []) << realm_id
      end
      # A frame's navigation planned — to a URL, a reload, a form's submission — replaces the one it had planned before
      # (HTML "navigate": a later navigation of a navigable aborts its ongoing one): `href = …` and then `reload()` in one
      # task reloads the document it is at (Chrome, measured: the reload's document, not the href's).
      # (…a form's submission its realm's plan as well — a later submission replaced the plan itself, in the realm, before
      # its slot is asked for: `submitted` — taken there where another kind of navigation comes: dropped where it
      # navigates the frame, whose navigation that replaces; kept, routed while the frame's document is there to ask
      # (`frame_submission_route`), where it navigates another navigable — the page for `_top`, as Chrome has it.)
      private def supersede_frame_navigation(realm_id, submitted: false)
        @pending_frame_nav&.delete(realm_id)
        @pending_frame_reload&.delete(realm_id)
        return unless (pending = @pending_frame_submit&.[](realm_id))
        return @pending_frame_submit.delete(realm_id) if submitted
        return if pending[:spec]

        spec = @runtime.frame_realm_alive?(realm_id) ? @runtime.realm_call(realm_id, '__csimTakePendingFormSubmit') : nil
        if spec.is_a?(Hash) && !frame_self_target?(spec['target'].to_s)
          pending.merge!(spec: spec, route: frame_submission_route(realm_id, spec))
        else
          @pending_frame_submit.delete(realm_id)
        end
      rescue StandardError
        nil
      end
      def consume_pending_frame_reload
        return if @pending_frame_reload.nil? || @pending_frame_reload.empty?
        realm_ids = @pending_frame_reload.uniq
        @pending_frame_reload = nil
        realm_ids.each do |realm_id|
          invalidate_find_cache
          # An entered `within_frame` frame reloads through `navigate_frame` (keeps
          # the frame stack in sync) — re-fetching its current document URL, which
          # we read from the still-alive realm. (A blob: URL entered this way is
          # re-fetched through Rack and so does NOT reuse retained bytes — reloading
          # an *entered* revoked-blob frame is an accepted gap; the common parent-
          # held path below reuses bytes via _reloadFrame.) Otherwise (a parent's
          # `iframe.contentWindow.location.reload()`, empty href, or a realm torn
          # down between flag and drain) re-navigate the owning iframe by realm id
          # JS-side, reusing the retained content so blob bytes survive a revoke.
          entry = @frame_stack.find {|e| e[:realm_id] == realm_id }
          url   = entry && @runtime.frame_realm_alive?(realm_id) ? @runtime.realm_call(realm_id, '__csimLocationHref').to_s : ''
          cur   = current_frame_history_entry(realm_id)
          if entry && !url.empty?
            navigate_frame(url, entry: entry, referrer: realm_referrer_initiator(realm_id), reload: true)
          elsif cur && cur[:method] == 'POST'
            # Reloading a document reached by POST re-POSTS it (isReloadNavigation) with the recorded
            # body, rather than the JS reload path's GET refetch of the frame's src.
            navigate_realm_self_post(realm_id, cur[:url], cur[:body], cur[:content_type], is_reload: true)
          elsif cur && cur[:url].to_s.match?(%r{\Ahttps?://}i)
            # Reload the CURRENT history entry (isReloadNavigation), not the frame's `src`: after a
            # back/forward the src is stale, so `history.go(0)` / `location.reload()` must refetch the
            # entry's URL. (A blob:/data:/srcdoc frame keeps the JS reload path — it reuses retained
            # bytes a URL refetch can't reproduce.)
            reload_frame_to_entry(realm_id, cur, is_reload: true, is_history: false)
          else
            @runtime.call('__csimReloadFrameByRealm', realm_id)
          end
        rescue StandardError => e
          log_console('warn', "frame self-reload failed: #{e.message}")
        end
      end
      # A <form> submitted from INSIDE a nested browsing context (a frame realm
      # reached via `contentWindow`, not an entered `within_frame` block). The
      # planned submission is the initiating realm's (navigation_plan.rs), which no
      # top-page drain reads, so the JS side flags the realm here (mirrors
      # `frame_navigate_self`). Keyed by realm id; deferred + drained from
      # `drain_pending_navigation` so we never serialize/navigate while the
      # form's `submit()` is still on the V8 stack.
      # (…`target` the one its request names, `request` that request: one that navigates the page is the page's navigation
      # planned last, in a slot of the page's (`@pending_page_submission`), not the frame's — the one planned before it
      # superseded, a location's, a reload, a link's or a form's of the page, Chrome's `location.href = …;
      # frames[0].f.submit()` — and superseded in turn by one the page plans after it (`cancel_planned_navigation`),
      # whatever the frame plans: its request and route taken now, whatever becomes of the frame by the time the page
      # navigates; true where it is, the frame's plan of it the frame's to drop — handed over, not asked of the frame,
      # whose realm a frame still being built does not answer)
      # (…a frame still being built — its realm not yet one the host can ask — has its request taken as it is, routed as it
      # is drained, its navigables known by then)
      def frame_submit_self(realm_id, target = '', request = nil)
        return false if realm_id.nil? || realm_id.zero?
        supersede_frame_navigation(realm_id, submitted: true)
        pending = ((@pending_frame_submit ||= {})[realm_id] = {})
        return false unless request.is_a?(Hash)
        unless @runtime.frame_realm_alive?(realm_id)
          pending[:spec] = request
          return true
        end
        return false unless [TARGET_TOP, TARGET_PARENT].include?(target_keyword(target)) && top_level_realm_of(realm_id).zero?
        return false unless choose_named_navigable(realm_id, target) == :top

        @pending_frame_submit.delete(realm_id)
        cancel_planned_navigation
        @runtime.call('__csimSupersedePlanned')
        @pending_page_submission = {realm_id: realm_id, spec: request, route: frame_submission_route(realm_id, request)}
        true
      end
      def consume_pending_page_submission
        return unless (pending = @pending_page_submission)

        @pending_page_submission = nil
        invalidate_find_cache
        submit_frame_route(pending[:realm_id], pending[:spec], pending[:route])
      rescue StandardError => e
        log_console('warn', "nested-context form submission failed: #{e.message}")
      end
      def consume_pending_frame_submit
        return if @pending_frame_submit.nil? || @pending_frame_submit.empty?
        pending = @pending_frame_submit
        @pending_frame_submit = nil
        pending.each do |realm_id, entry|
          spec, route = entry[:spec], entry[:route]
          unless spec
            next unless @runtime.frame_realm_alive?(realm_id)
            spec = @runtime.realm_call(realm_id, '__csimTakePendingFormSubmit')
            next unless spec.is_a?(Hash)
          end
          route ||= frame_submission_route(realm_id, spec)
          invalidate_find_cache
          submit_frame_route(realm_id, spec, route)
        rescue StandardError => e
          log_console('warn', "nested-context form submission failed: #{e.message}")
        end
      end
      # ── Frame session history ──────────────────────────────────────────────
      # A nested browsing context (iframe) keeps its OWN back/forward history of
      # the documents it navigates through, with each entry's form-control state
      # captured for restoration (HTML "persisted user state" / bfcache). Keyed by
      # [parent realm, iframe element handle] — stable across the frame-realm
      # rebuilds a navigation triggers (the element outlives its realm).
      #
      # `iframe.contentWindow.history.back()` runs while the frame realm is on the
      # V8 stack, so (like frame_navigate_self) DEFER the traversal and drain it
      # after the call returns — rebuilding the realm inline would terminate it.
      def frame_history_go(realm_id, delta)
        return if realm_id.nil? || realm_id.zero?
        @pending_frame_traverse = {realm_id: realm_id, delta: delta.to_i}
      end
      def consume_pending_frame_traverse
        return if @pending_frame_traverse.nil?
        pt = @pending_frame_traverse
        @pending_frame_traverse = nil
        invalidate_find_cache
        perform_frame_traverse(pt[:realm_id], pt[:delta])
      rescue StandardError => e
        log_console('warn', "frame history traversal failed: #{e.message}")
      end
      def perform_frame_traverse(realm_id, delta)
        # The traversal was deferred; the frame may have been disposed (a competing
        # nav) between flag and drain — drop it gracefully.
        return unless @runtime.frame_realm_alive?(realm_id)
        parent = @runtime.frame_realm_parent(realm_id)
        handle = frame_container_handle(realm_id, parent)
        return if handle.zero?
        h = (@frame_histories ||= {})[[parent, handle]]
        return if h.nil?
        target = h[:idx] + delta
        return if target.negative? || target >= h[:entries].size
        # Snapshot the entry we're leaving so a later forward traversal restores it (keeping how it
        # was reached, so a POST entry re-POSTs when traversed back to).
        leave_frame_entry(realm_id, h) if h[:idx] >= 0
        reload_frame_to_entry(realm_id, h[:entries][target])
        h[:idx] = target   # advance only after the rebuild succeeds
      end
      # Record a frame navigation away from `realm_id` to `new_url`: snapshot the
      # OUTGOING document (URL + form state) into the current entry — seeding entry
      # 0 the first time — then drop any forward tail and push the new entry. Hooked
      # into the frame form-submission paths; frame navigations driven by
      # `location.href` / link clicks aren't recorded yet (history.back there falls
      # through to the top document, as before).
      # `post` (a {body, content_type}) records that this entry was reached by a POST submission,
      # so a later reload / history traversal re-POSTs it (with the body) rather than GET-ing the URL.
      def record_frame_nav(realm_id, new_url, post: nil)
        return if realm_id.nil? || realm_id.zero?
        parent = @runtime.frame_realm_parent(realm_id)
        handle = frame_container_handle(realm_id, parent)
        return if handle.zero?
        h = (@frame_histories ||= {})[[parent, handle]] ||= {entries: [], idx: -1}
        h[:idx] = 0 if h[:idx].negative?
        leave_frame_entry(realm_id, h)
        h[:entries] = h[:entries][0..h[:idx]]
        entry = {url: new_url.to_s, form_state: nil}
        entry.merge!(method: 'POST', body: post[:body], content_type: post[:content_type]) if post
        h[:entries] << entry
        h[:idx] = h[:entries].size - 1
      end
      # The frame's CURRENT history entry (the loaded document), or nil — read by a reload to decide
      # whether to re-POST.
      def current_frame_history_entry(realm_id)
        parent = @runtime.frame_realm_parent(realm_id)
        handle = frame_container_handle(realm_id, parent)
        return nil if handle.zero?
        h = (@frame_histories || {})[[parent, handle]]
        h && h[:idx] >= 0 ? h[:entries][h[:idx]] : nil
      end
      # The history entry for the document currently loaded in `realm_id`: its URL
      # plus a snapshot of its form-control state.
      def frame_history_entry(realm_id)
        {url: frame_realm_url(realm_id), form_state: capture_frame_form_state(realm_id)}
      end
      # Refresh the outgoing entry's url + form-state snapshot while PRESERVING how it was reached
      # (a POST entry's method / body / content_type) — leaving a document doesn't change the request
      # that loaded it, so a later traversal back re-POSTs rather than GET-ing.
      def snapshot_outgoing_entry(realm_id, prev)
        snap = frame_history_entry(realm_id)
        prev ? prev.merge(snap) : snap
      end
      # The frame history `h` leaving its current entry for the document in `realm_id`: snapshotted now, and its form
      # state again as the document is unloaded (`frame_document_unloaded`) — what its pagehide / unload handlers left
      # is what a traversal back restores (Chrome). The snapshot taken now stands when the navigation never commits.
      def leave_frame_entry(realm_id, h)
        entry = h[:entries][h[:idx]] = snapshot_outgoing_entry(realm_id, h[:entries][h[:idx]])
        (@frame_leaving_entries ||= {})[realm_id] = entry
      end
      # A frame's document unloaded (its pagehide and unload fired, its realm still alive): the history entry its
      # navigation is leaving takes its form state as its handlers left it.
      def frame_document_unloaded(realm_id)
        entry = @frame_leaving_entries&.delete(realm_id)
        entry[:form_state] = capture_frame_form_state(realm_id) if entry
      end
      def frame_realm_url(realm_id)
        return @runtime.loading_frame_realm_url(realm_id) unless @runtime.frame_realm_alive?(realm_id)

        @runtime.realm_call(realm_id, '__csimLocationHref').to_s
      rescue StandardError
        nil
      end
      # A frame document's referrer policy (its last valid `<meta name="referrer">`), read from
      # the live realm to compute a self-navigation's Referer under the initiating document's
      # policy. '' when the realm is gone / has no meta → the platform default applies.
      def main_document_referrer_policy
        @runtime.call('__csimDocumentReferrerPolicy').to_s
      rescue StandardError
        ''
      end
      def frame_document_referrer_policy(realm_id)
        return '' unless @runtime.frame_realm_alive?(realm_id)
        @runtime.realm_call(realm_id, '__csimDocumentReferrerPolicy').to_s
      rescue StandardError
        ''
      end
      def frame_document_origin_opaque?(realm_id)
        @runtime.frame_realm_alive?(realm_id) && @runtime.realm_call(realm_id, '__csimDocumentOriginOpaque') == true
      rescue StandardError
        false
      end
      def capture_frame_form_state(realm_id)
        return nil unless @runtime.frame_realm_alive?(realm_id)
        @runtime.realm_call(realm_id, '__csimCaptureFormState')
      end
      # Re-fetch a history entry's URL and rebuild the frame realm from it, then restore the entry's
      # captured form state (before the element load fires). Used for a history traversal
      # (isHistoryNavigation) AND for a reload of the current entry (isReloadNavigation — e.g.
      # `history.go(0)` / `location.reload()` after a back/forward, where the frame's `src` is stale
      # and only the current entry names the right URL).
      def reload_frame_to_entry(realm_id, entry, is_reload: false, is_history: true)
        url = entry[:url].to_s
        return if url.empty?
        # An entry reached by a POST submission re-POSTS (with the recorded body); a normal entry
        # re-GETs. The method drives both the SW fetch event and the network fallback.
        is_post   = entry[:method] == 'POST'
        body      = entry[:body].to_s
        post_args = is_post ? {method: 'POST', body: body, content_type: entry[:content_type]} : {}
        # A history TRAVERSAL restores the entry's persisted form state (bfcache); a RELOAD gives a
        # fresh document, so it must NOT restore the (possibly stale) snapshot the entry was left with.
        restore = is_reload ? nil : entry[:form_state]
        # A traversal / reload is a navigation: route it through the controlling SW's fetch event
        # first — the refetch happens here, Ruby-side, bypassing the __csimFrameWindow interception
        # the initial load uses. A respondWith serves the document; a network error fails the
        # navigation; nil falls through to the network below. Same secure-ancestors gate as
        # navigate_realm_self_get. KNOWN GAP: an SW-served REDIRECT here commits the redirect
        # response's body instead of following it (no vendored test reloads into a redirecting
        # respondWith; following would need the entry/restore plumbing threaded through the
        # re-entry) — extend when a test pins the behavior.
        # A reload / traversal creates a fresh document, so it gets its own reserved
        # client id, adopted by the rebuilt realm (same model as a fresh navigation).
        rid = mint_resulting_client_id
        referrer_source, referrer_policy = realm_referrer_initiator(realm_id)
        return unless prompt_to_unload_frame(realm_id)

        if (!url.to_s.start_with?('https://') || sw_may_control_frame_navigation?(realm_id)) &&
           (sw = any_window_sw_navigation_fetch(url, is_reload: is_reload, is_history: is_history,
                                                      referrer_source: referrer_source, referrer_policy: referrer_policy,
                                                      resulting_client_id: rid, **post_args))
          return commit_frame_error_document(realm_id, url, rid) if sw['networkError']

          # Raw decoded bytes (like read_rack_body's byte-tagged output); reload_frame_realm_by_id
          # does the single utf8_text re-tag, matching the network path below.
          reload_frame_realm_by_id(realm_id, url, Base64.decode64(sw['body_b64'].to_s),
                                   response_content_type(sw['headers'] || {}), restore_state: restore, client_id: rid, csp: response_csp(sw['headers'] || {}))
          return
        end
        env = rack_env_for(url, method: is_post ? 'POST' : 'GET', input: is_post ? body : '')
        if is_post
          env['CONTENT_TYPE']   = entry[:content_type].to_s.empty? ? 'application/x-www-form-urlencoded' : entry[:content_type]
          env['CONTENT_LENGTH'] = body.bytesize.to_s
        end
        apply_default_request_env(env, referer: compute_referrer(referrer_policy, referrer_source, url))
        response = dispatch_rack_or_http(url, env, method: is_post ? 'POST' : 'GET', body: is_post ? body : nil) or return commit_frame_error_document(realm_id, url, rid)
        status, headers, resp_body = response
        merge_set_cookie(headers, url, env)
        return if download_response?(headers)
        reload_frame_realm_by_id(realm_id, url, read_rack_body(resp_body), response_content_type(headers), restore_state: restore, csp: response_csp(headers))
      end
      # A form submitted inside frame realm `realm_id`, its request as it was submitted (`spec`, serialized in that realm:
      # its shadow trees' controls left out, its action resolved against its document): routed, then navigated.
      def submit_form_in_realm(realm_id, spec)
        submit_frame_route(realm_id, spec, frame_submission_route(realm_id, spec))
      end
      # …where it goes, asked of the frame's document while it is there: [chosen, initiator] — `:self` its own frame (a
      # self-targeted link's navigation: within_frame's `navigate_frame`, else its iframe re-navigated by realm id), `:top`
      # the page (`_top`, a `_parent` that is the page, or a name the page has), a frame's realm (a name's, `_parent`'s),
      # `:window` a same-isolate window's (its navigation not modeled), nil a new window (not modeled), `:blocked` none
      # its sandbox lets it navigate — and its Referer: the frame's document's, under its policy or `noreferrer`'s.
      def frame_submission_route(realm_id, spec)
        initiator = realm_referrer_initiator(realm_id)
        initiator = [initiator[0], 'no-referrer'] if Native.link_noreferrer(spec['rel'].to_s)
        target = spec['target'].to_s
        return [:self, initiator] if frame_self_target?(target)

        chosen = target_keyword(target) == TARGET_BLANK ? nil : choose_named_navigable(realm_id, target)
        # (…the top-level one of a frame of a same-isolate window is that window, not the page)
        if chosen == :top
          chosen = :window if top_level_realm_of(realm_id).positive?
        elsif chosen.is_a?(Integer) && @runtime.top_level_realm?(chosen)
          chosen = :window
        end
        [chosen, initiator]
      end
      def submit_frame_route(realm_id, spec, route)
        chosen, initiator = route
        request = form_request(spec, spec['action'].to_s)
        return unless request

        method, url, body, content_type = request
        case chosen
        when :self
          if method == 'GET'
            navigate_realm_self_get(realm_id, url, referrer: initiator)
          else
            navigate_realm_self_post(realm_id, url, body, content_type, referrer: initiator)
          end
        when :top
          # (…adding the page's entry, whether the frame's document is completely loaded or not: a form's replaces only its
          # own navigable's — HTML "plan to navigate", the form document the target's active document)
          in_top_context { navigate_top_from(realm_id, initiator, url, post: method == 'GET' ? nil : [body, content_type]) }
        when Integer
          if method == 'GET'
            navigate_realm_self_get(chosen, url, referrer: initiator)
          else
            navigate_realm_self_post(chosen, url, body, content_type, referrer: initiator)
          end
        when :window
          log_console('warn', "nested-context form submit (target=#{spec['target'].to_s.inspect}) into a window of this browser is not modeled")
        when nil
          log_console('warn', "nested-context form submit (target=#{spec['target'].to_s.inspect}) into a new window is not modeled")
        end
      end
      # The top-level realm realm `realm_id`'s browsing context is in: 0, the page's, or a same-isolate window's.
      def top_level_realm_of(realm_id)
        realm = realm_id.to_i
        realm = @runtime.frame_realm_parent(realm) until @runtime.top_level_realm?(realm)
        realm
      end
      # The navigable a target name — or `_top` / `_parent` — chooses from realm `realm_id`'s browsing context
      # (navigables.rs `findNavigable`, `keyword_navigable`): a frame's realm — made now, where its navigable has no
      # document yet — `:top` (its top-level traversable's), `:blocked` (one its sandbox keeps it from navigating), or nil
      # (none has the name).
      def choose_named_navigable(realm_id, target)
        keyword = target_keyword(target)
        realm = if [TARGET_TOP, TARGET_PARENT].include?(keyword)
          @runtime.realm_call(realm_id, '__csimKeywordNavigable', keyword)
        else
          @runtime.realm_call(realm_id, '__csimFindNamedFrame', target.to_s)
        end
        case (realm = realm.to_i)
        when -1 then :blocked
        when -2 then :top
        else realm.positive? ? realm : nil
        end
      end
      # Whether a link's or a form's target opens a new browsing context — `_blank`, or a name no navigable has (the page
      # chose the one that has it first: `choose_named_navigable`).
      def new_window_target?(target)
        [TARGET_NAME, TARGET_BLANK].include?(target_keyword(target)) && @driver.respond_to?(:open_aux_window)
      end

      # A self-targeted GET form submit in the initiating frame realm: navigate
      # that frame to the action URL (query already mutated in).
      # `record: false` for a `location.href=` / link-click self-nav — those frame navigations are
      # deliberately NOT recorded in frame history yet (see record_frame_nav; history.back there falls
      # through to the top document), and recording them here would push an entry where a
      # `location.replace` must overwrite. A form GET submission (the default) IS a history push.
      def navigate_realm_self_get(realm_id, get_url, depth: 0, is_reload: false, is_history: false, record: true, site_seed: nil, origin_null: false, resulting_client_id: nil, referrer: nil)
        raise 'too many redirects' if depth > 10
        referrer ||= realm_referrer_initiator(realm_id)
        record_frame_nav(realm_id, get_url) if record && depth.zero? && !is_reload && !is_history
        # The navigation's reserved client id — threaded through the redirect re-entries
        # (re-minted on a cross-origin hop) and adopted by the rebuilt realm on commit.
        rid = resulting_client_id || mint_resulting_client_id
        entry = @frame_stack.find {|e| e[:realm_id] == realm_id }
        return navigate_frame(resolve_against_current(get_url), entry: entry, referrer: referrer) if entry
        # A frame reached via contentWindow (not on the entered stack). An ABSOLUTE http(s) target is
        # fetched Ruby-side (like navigate_realm_self_post) so the navigation carries correct request
        # headers — a Referer under the initiating document's Referrer-Policy, no Origin (GET), the
        # Fetch-Metadata triple. A non-http(s) target (data:/blob:/javascript:/about:blank) or a
        # relative one stays on the JS src-reassignment path, which owns those schemes and resolves a
        # relative URL against the frame's base on rebuild — routed through the frame's PARENT realm
        # (where the owning iframe lives), not unconditionally to main.
        parent = @runtime.frame_realm_parent(realm_id)
        unless get_url.is_a?(String) && get_url.match?(%r{\Ahttps?://}i)
          # (…one a redirect reached a network error — Fetch's HTTP-redirect fetch takes no location URL of another
          # scheme — its failed load committed at the URL)
          return reload_frame_realm_by_id(realm_id, get_url.to_s, '', 'text/html') if depth.positive?

          return frame_realm_host_call(parent, '__csimNavigateFrameByRealm', realm_id, get_url)
        end
        # The realm may have been disposed earlier in THIS drain batch — an ancestor frame that also
        # self-navigated discarded this descendant (dispose_frame_realm_tree). Bail before issuing a
        # network fetch whose response (reload_frame_realm_by_id) would find no container and be thrown
        # away — the fetch's cookie / server side effects would fire for a navigation that never commits.
        return unless @runtime.frame_realm_alive?(realm_id)
        return if depth.zero? && !prompt_to_unload_frame(realm_id, parent)

        invalidate_find_cache
        # The frame's ancestor-chain cookie verdict (see frame_ancestor_cross_site?) —
        # a property of the frame the document commits into, so it rides the SW fetch
        # event too (a rewritten request keeps it; the initiator latch doesn't apply).
        cookie_cross = frame_ancestor_cross_site?(realm_id, get_url)
        # A controlled navigation goes to the SW's fetch event first (mode 'navigate'); respondWith
        # serves the document, a network error fails it, nil falls through to the network GET below.
        # Skipped when an https navigation sits under an insecure ancestor (see
        # frame_navigation_fetch — the http-target carve-out is the app-suite fiction).
        initiator, referrer_policy = referrer
        if (!get_url.start_with?('https://') || sw_may_control_frame_navigation?(realm_id)) &&
           (sw = any_window_sw_navigation_fetch(get_url, method: 'GET', is_reload: is_reload, is_history: is_history,
                                                          referrer_source: initiator, referrer_policy: referrer_policy,
                                                          site_seed: site_seed, origin_null: origin_null, cookie_cross_site: cookie_cross, resulting_client_id: rid))
          return commit_frame_error_document(realm_id, get_url, rid) if sw['networkError']

          # An SW-served redirect is FOLLOWED like a network one (the recursion
          # re-enters interception at the new URL — a redirect out of this SW's scope
          # lands on the network or another registration's SW, as in the top-level
          # navigate path). The chain latches Sec-Fetch-Site exactly like the network
          # redirect branch below.
          if (loc = redirect_location(sw['status'].to_i, sw['headers'] || {}))
            next_url = carry_fragment(get_url, resolve_against(loc, get_url))
            return navigate_realm_self_get(realm_id, next_url, depth: depth + 1, referrer: referrer, is_reload: is_reload, is_history: is_history, record: record,
                                                     site_seed: widen_sec_fetch_site(site_seed, sec_fetch_site(initiator, get_url)),
                                                     origin_null: redirect_taints_origin?(origin_null, initiator, get_url, next_url),
                                                     resulting_client_id: url_origin(next_url) == url_origin(get_url) ? rid : nil)
          end
          return reload_frame_realm_by_id(realm_id, get_url, Base64.decode64(sw['body_b64'].to_s), response_content_type(sw['headers'] || {}), client_id: rid, csp: response_csp(sw['headers'] || {}))
        end
        site      = widen_sec_fetch_site(site_seed, sec_fetch_site(initiator, get_url))
        response = dispatch_navigation_request(
          get_url,
          method:            'GET',
          initiator:         initiator,
          referrer_policy:   referrer_policy,
          site:              site,
          origin_null:       origin_null,
          cookie_cross_site: cookie_cross
        ) or return commit_frame_error_document(realm_id, get_url, rid)
        status, headers, resp_body = response
        if (loc = redirect_location(status, headers))
          next_url = carry_fragment(get_url, resolve_against(loc, get_url))
          resp_body.close if resp_body.respond_to?(:close)
          # Latch the redirect chain's Fetch-Metadata: Sec-Fetch-Site widens to include this hop, and
          # a form POST's Origin taints to 'null' per redirect_taints_origin? (moot for GET — no Origin).
          return navigate_realm_self_get(realm_id, next_url, depth: depth + 1, referrer: referrer, is_reload: is_reload, is_history: is_history, record: record,
                                                   site_seed: site, origin_null: redirect_taints_origin?(origin_null, initiator, get_url, next_url),
                                                   resulting_client_id: url_origin(next_url) == url_origin(get_url) ? rid : nil)
        end
        if download_response?(headers)
          return save_downloaded_response(get_url, headers, resp_body, realm: realm_id)
        end
        reload_frame_realm_by_id(realm_id, get_url, read_rack_body(resp_body), response_content_type(headers), client_id: rid, csp: response_csp(headers))
      end
      # A self-targeted POST form submit in the initiating frame realm. POST the
      # entity body to the action URL, then rebuild that frame's realm from the
      # response. An ENTERED frame (on @frame_stack) reuses navigate_frame_post;
      # a frame reached via contentWindow has no stack entry, so rebuild it by
      # realm id (recovering its container element + parent realm) and fire the
      # iframe element's load event the GET/src path would.
      def navigate_realm_self_post(realm_id, url, body, content_type, depth: 0, is_reload: false, is_history: false, site_seed: nil, origin_null: false, resulting_client_id: nil, referrer: nil)
        raise 'too many redirects' if depth > 10
        referrer ||= realm_referrer_initiator(realm_id)
        # A reload / history traversal RE-POSTS an existing entry — it doesn't push a new one; only
        # a fresh submission records history. The POST method/body is tagged onto the entry AFTER a
        # DIRECT (non-redirect) response (tag_frame_entry_post below): a POST that redirects (the
        # Post/Redirect/Get pattern) resolves to a GET document, so its entry must NOT re-POST on a
        # later reload / back — only a directly-served POST does.
        record_frame_nav(realm_id, url) if depth.zero? && !is_reload && !is_history
        entry = @frame_stack.find {|e| e[:realm_id] == realm_id }
        return navigate_frame_post(url, body, content_type, entry: entry, referrer: referrer) if entry
        return if depth.zero? && !prompt_to_unload_frame(realm_id)

        invalidate_find_cache
        # The navigation's reserved client id — same threading as navigate_realm_self_get.
        rid = resulting_client_id || mint_resulting_client_id
        # The frame's ancestor-chain cookie verdict — same as navigate_realm_self_get.
        cookie_cross = frame_ancestor_cross_site?(realm_id, url)
        # A controlled POST navigation goes to the SW's fetch event first (mode 'navigate', method
        # POST — the SW reads the body via event.request.text()); respondWith serves the document,
        # a network error fails it, nil falls through to the network POST below.
        # Skipped when an https navigation sits under an insecure ancestor (see
        # frame_navigation_fetch — the http-target carve-out is the app-suite fiction).
        initiator, referrer_policy = referrer
        if (!url.to_s.start_with?('https://') || sw_may_control_frame_navigation?(realm_id)) &&
           (sw = any_window_sw_navigation_fetch(url, method: 'POST', body: body, content_type: content_type, is_reload: is_reload, is_history: is_history,
                                                      referrer_source: initiator, referrer_policy: referrer_policy,
                                                      site_seed: site_seed, origin_null: origin_null, cookie_cross_site: cookie_cross, resulting_client_id: rid))
          return commit_frame_error_document(realm_id, url, rid) if sw['networkError']

          # SW-served redirect: 307/308 re-POST, everything else GETs — the same split
          # as the network branch below, re-entering interception at the new URL.
          if (loc = redirect_location(sw['status'].to_i, sw['headers'] || {}))
            next_url = carry_fragment(url, resolve_location(loc, url))
            site     = widen_sec_fetch_site(site_seed, sec_fetch_site(initiator, url.to_s))
            taint    = redirect_taints_origin?(origin_null, initiator, url.to_s, next_url)
            next_rid = url_origin(next_url) == url_origin(url.to_s) ? rid : nil
            if [307, 308].include?(sw['status'].to_i)
              return navigate_realm_self_post(realm_id, next_url, body, content_type, depth: depth + 1, referrer: referrer, is_reload: is_reload, is_history: is_history,
                                                         site_seed: site, origin_null: taint, resulting_client_id: next_rid)
            end

            return navigate_realm_self_get(realm_id, next_url, depth: depth + 1, referrer: referrer, is_reload: is_reload, is_history: is_history, record: false,
                                                     site_seed: site, origin_null: taint, resulting_client_id: next_rid)
          end
          tag_frame_entry_post(realm_id, body, content_type) if depth.zero?
          reload_frame_realm_by_id(realm_id, url.to_s, Base64.decode64(sw['body_b64'].to_s), response_content_type(sw['headers'] || {}), client_id: rid, csp: response_csp(sw['headers'] || {}))
          return
        end
        # The initiator is the FRAME's own document (an iframe srcdoc one's container's — `realm_referrer_initiator`; still alive — the rebuild is below), not the
        # top document `current_browsing_context_url` returns for a non-entered frame. A form POST
        # navigation carries that document's Origin + a Referer under its Referrer-Policy + the
        # Fetch-Metadata triple (Sec-Fetch-Dest 'iframe' for a subframe).
        site      = widen_sec_fetch_site(site_seed, sec_fetch_site(initiator, url.to_s))
        response = dispatch_navigation_request(
          url,
          method:            'POST',
          initiator:         initiator,
          referrer_policy:   referrer_policy,
          site:              site,
          origin_null:       origin_null,
          body:              body,
          content_type:      content_type,
          cookie_cross_site: cookie_cross
        ) or return commit_frame_error_document(realm_id, url, rid)
        status, headers, resp_body = response
        if (loc = redirect_location(status, headers))
          next_url = carry_fragment(url, resolve_location(loc, url))
          resp_body.close if resp_body.respond_to?(:close)
          # 307/308 preserve method + body; 301/302/303 → GET the frame — the same split as the SW branch above, the
          # navigation going on (its document prompted to unload once, at its start). Latch the redirect chain's
          # Sec-Fetch-Site (widened) + Origin taint (redirect_taints_origin?).
          taint    = redirect_taints_origin?(origin_null, initiator, url.to_s, next_url)
          next_rid = url_origin(next_url) == url_origin(url.to_s) ? rid : nil
          unless Native.redirect_to_get(status.to_i, 'POST')
            return navigate_realm_self_post(realm_id, next_url, body, content_type, depth: depth + 1, referrer: referrer, is_reload: is_reload, is_history: is_history,
                                                       site_seed: site, origin_null: taint, resulting_client_id: next_rid)
          end

          return navigate_realm_self_get(realm_id, next_url, depth: depth + 1, referrer: referrer, is_reload: is_reload, is_history: is_history, record: false,
                                                   site_seed: site, origin_null: taint, resulting_client_id: next_rid)
        end
        if download_response?(headers)
          save_downloaded_response(url, headers, resp_body, realm: realm_id)
          return
        end
        tag_frame_entry_post(realm_id, body, content_type) if depth.zero?
        reload_frame_realm_by_id(realm_id, url.to_s, read_rack_body(resp_body), response_content_type(headers), client_id: rid, csp: response_csp(headers))
      end
      # Tag the frame's current history entry as reached by a POST (with its body), so a later
      # reload / history traversal re-POSTS it. Applied only on a DIRECT response (not a redirect),
      # so a Post/Redirect/Get entry stays a GET.
      def tag_frame_entry_post(realm_id, body, content_type)
        cur = current_frame_history_entry(realm_id)
        cur.merge!(method: 'POST', body: body, content_type: content_type) if cur
      end
      # Rebuild a frame realm reached via contentWindow (no @frame_stack entry):
      # recover its container element handle + parent realm, swap in a fresh realm
      # built from `html`, re-point the iframe at it, and fire the element load.
      def reload_frame_realm_by_id(realm_id, url, bytes, content_type, restore_state: nil, client_id: nil, csp: nil)
        parent = @runtime.frame_realm_parent(realm_id)
        handle = frame_container_handle(realm_id, parent)
        return if handle.zero?
        # (…none where its container is gone: no document of it made unsandboxed, as an empty seed would)
        seed = frame_realm_host_call(parent, '__csimFrameSeed', handle, url.to_s, csp, navigation_sandbox(realm_id)) or return
        return unless unload_frame_document(parent, realm_id)

        new_id = @runtime.reload_frame_realm(realm_id, parent.to_i, url, document_payload(bytes), content_type, client_id, seed).to_i
        return if new_id.zero?
        begin
          rebind_frame_realm(parent, handle, realm_id, new_id)
          # Restore captured form state (history traversal) BEFORE the element load
          # fires, so the restored values are in place by the time the parent's
          # `iframe.onload` handler — and any assertion after it — runs.
          @runtime.realm_call(new_id, '__csimRestoreFormState', restore_state) if restore_state
          frame_realm_host_call(parent, '__csimFireFrameElementLoad', handle)
        rescue StandardError
          # The element rebind/load failed — don't strand the freshly built realm
          # (it's no longer referenced by any iframe), then surface the error.
          @runtime.dispose_frame_realm(new_id)
          raise
        end
        invalidate_find_cache
        settle
        new_id
      end
      # The iframe/frame element handle that owns `realm_id`, found in the document
      # of its parent realm (main realm for a top-level frame).
      def frame_container_handle(realm_id, parent)
        frame_realm_host_call(parent, '__csimGetFrameHandle', realm_id).to_i
      end
      # Call a host fn in the realm that OWNS an iframe (main realm for 0/nil).
      # A frame's navigation asks its document whether it may be unloaded before it fetches anything (HTML "check if
      # unloading is canceled": its `beforeunload`, and its frames' — `__csimPromptToUnloadFrame`): false when a handler
      # removed the frame, the navigation then going no further.
      def prompt_to_unload_frame(realm_id, parent = @runtime.frame_realm_parent(realm_id))
        frame_realm_host_call(parent, '__csimPromptToUnloadFrame', realm_id) != false
      end
      # …and, its response in, its document unloaded (pagehide and unload, its frames' after it) while still the frame's
      # — false when a handler of them removed the frame, the response then having nowhere to go: what is left of the old
      # realm disposed.
      def unload_frame_document(parent, realm_id)
        return true if frame_realm_host_call(parent, '__csimTearDownFrameDocument', realm_id) != false

        @runtime.dispose_frame_realm_tree(realm_id)
        false
      end
      def frame_realm_host_call(parent_realm_id, fn, *args)
        if parent_realm_id.nil? || parent_realm_id.zero?
          @runtime.call(fn, *args)
        else
          @runtime.realm_call(parent_realm_id, fn, *args)
        end
      end
      # A page whose `load` handler navigates gets another document, which owes another
      # load — legitimate, and finite in every real page. This caps the chain.
      WINDOW_LOAD_CHAIN_MAX = 8

      def drain_pending_navigation
        drain_pending_navigation_once
        # AFTER the consumes, not before: a page-initiated navigation (a link click, a
        # form submit) BOOTS its document in one of them, so the marker it leaves is
        # only there to act on once they have run — firing first meant a clicked link
        # never fired a load at all.
        #
        # ITERATIVE, not recursive: a `load` handler may navigate again, and that
        # navigation's own document owes another load. Bounded, because a pair of
        # pages whose load handlers navigate to each other would otherwise recurse
        # until the Ruby stack gives out (measured: ~5900 document boots).
        WINDOW_LOAD_CHAIN_MAX.times do
          break unless flush_pending_window_load

          drained = pending_nav_intent?
          drain_pending_navigation_once
          break unless drained
        end
      end

      # One pass of the intent drain, without the window-load chaining above.
      def drain_pending_navigation_once
        consume_pending_sw_client_nav
        consume_pending_location
        consume_pending_frame_nav
        consume_pending_frame_submit
        consume_pending_page_submission
        consume_pending_frame_reload
        consume_pending_frame_traverse
        consume_pending_reload
        consume_pending_history_traverse
        consume_pending_aux_window
      end

      # A script-driven `anchor.click()` / `target=_blank` navigation with no
      # Capybara action behind it (e.g. a WPT test) — open the aux window from the
      # event-loop drain. Safe mid-call (builds a separate Browser). Same-window /
      # frame navs are left untouched (handled by drain_after_user_action).
      def consume_pending_aux_window
        pending = @runtime.call('__csimTakePendingAuxWindow')
        return unless pending.is_a?(Hash) && pending['url'] && @driver.respond_to?(:open_aux_window)
        url = in_top_context { resolve_against_current(pending['url'].to_s, use_base: true) }
        open_hyperlink_window(
          url,
          target:      pending['target'],
          opener:      pending['opener'],
          link_policy: pending['referrerPolicy'],
          blob:        pending['blob'],
          realm_id:    0
        )
      rescue StandardError => e
        log_console('warn', "aux-window open failed: #{e.message}")
      end
      # POST-after-POST resubmits with the original body; GET-after-GET
       # is just a re-GET. Replay the current history entry.
      def refresh
        # Before the replay below commits anything (see `flush_outgoing_page_init`).
        flush_outgoing_page_init if @timers_active
        replay_history_entry(@history[@history_idx], is_reload: true)
        restore_flushed_nav_intents
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
      def history_state(url, state = nil, realm_id = 0)
        return note_frame_same_document_url(realm_id.to_i, url) unless realm_id.to_i.zero?

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
      def history_push(url, state = nil, realm_id = 0)
        return note_frame_same_document_url(realm_id.to_i, url) unless realm_id.to_i.zero?

        resolved = resolve_against_current(url.to_s)
        record_url_transition(resolved)
        @current_url = resolved
        record_history({method: :get, url: resolved, state: state, kind: :push_state})
      end

      # A SAME-DOCUMENT URL change (pushState / replaceState / a fragment navigation) made by a
      # NESTED browsing context. It belongs to that frame's own session history — mirroring it onto
      # the top document's would make `current_url` report a URL no window is at, which is what an
      # iframe'd SPA does on every navigation. Recorded as the current entry's URL (rather than a
      # new entry) so a later `location.reload()` refetches the pushState'd URL, not the stale
      # `src`; in-frame same-document TRAVERSAL over such entries is still unmodelled.
      # A same-isolate window realm (a popup) has no iframe container and so no entry to update —
      # its handle is 0, and not touching the top history is already the fix there.
      private def note_frame_same_document_url(realm_id, url)
        return nil if url.nil? || realm_id.zero?

        parent = @runtime.frame_realm_parent(realm_id)
        handle = frame_container_handle(realm_id, parent)
        return nil if handle.zero?

        h = (@frame_histories ||= {})[[parent, handle]] ||= {entries: [], idx: -1}
        if h[:idx].negative?
          # Seed entry 0 from the document as it is NOW — this runs before the location update,
          # so it still reads the URL the frame was loaded at.
          h[:entries] << frame_history_entry(realm_id)
          h[:idx] = 0
        end
        h[:entries][h[:idx]] = (h[:entries][h[:idx]] || {}).merge(url: url.to_s)
        nil
      end

      # Total history entries (after forward-tail truncation), surfaced
      # to JS `history.length` via the `__historyLength` host fn.
      def history_length
        [@history.size, 1].max
      end
      # The host a URL names, or nil for one with none (about:blank / data: / a relative current_url before the first
      # navigate).
      def cookie_host(url)
        h = parse_url(url.to_s)&.fetch(:hostname)
        h && !h.empty? ? h : nil
      end

      # The URL a request built into `env` is for — the TARGET server's (SERVER_NAME / HTTP_HOST), not the current
      # document's, so a cross-origin fetch sends the target's cookies rather than leaking the document's (cors-cookies);
      # read off the request itself, never a forwarding header a page may set (X-Forwarded-Host, Forwarded) — and
      # whether it goes over a secure channel.
      def env_request_url(env)
        "#{env['rack.url_scheme']}://#{env['HTTP_HOST'] || env['SERVER_NAME']}#{env['SCRIPT_NAME']}#{env['PATH_INFO']}"
      end
      def env_secure_channel?(env)
        %w[https wss].include?(env['rack.url_scheme']) || secure_cookie_channel?("http://#{env['HTTP_HOST'] || env['SERVER_NAME']}")
      end

      # The context a cookie is set or retrieved in, as the session's cookie store (cookie_jar.rs) takes it: through an
      # HTTP API (not `document.cookie`), over a secure channel, for a cross-site request, one where a Lax cookie goes.
      COOKIE_HTTP       = 1
      COOKIE_SECURE     = 2
      COOKIE_CROSS_SITE = 4
      COOKIE_LAX_OK     = 8
      # (…the time a cookie expires by: the app's clock, which a test may travel)
      def cookie_now = Time.now.to_f * 1000

      # The `Cookie` request-header value for a request to `url`: the cookies the store retrieves for it (RFC 6265bis
      # §5.8.3) — its host's and those of a domain it domain-matches, whose path its path matches. `secure:` is the
      # transport of the request being built — a Secure cookie is omitted from any other (§5.4 step 1); REQUIRED so a
      # new caller can't silently fail open. `cross_site:` is the request's site relationship (from its own
      # Sec-Fetch-Site metadata): a SameSite=Strict cookie is withheld from any cross-site request; Lax — and the
      # unspecified default, which Chrome treats as Lax — additionally rides a cross-site TOP-LEVEL GET navigation
      # (`lax_ok:`); only SameSite=None crosses freely. `http: false` is `document.cookie`'s, which no HttpOnly cookie
      # is read through. The bytes the cookies' values are, as the server sent them.
      def cookie_header_for(url, secure:, cross_site: false, lax_ok: true, http: true)
        context = (http ? COOKIE_HTTP : 0) | (secure ? COOKIE_SECURE : 0) | (cross_site ? COOKIE_CROSS_SITE : 0) | (lax_ok ? COOKIE_LAX_OK : 0)
        Native.cookie_jar_get(@cookie_jar, url.to_s, context, cookie_now)
      end

      # …and a set-cookie-string received for `url`, stored as the store says (§5.7) — a SameSite one not from a
      # cross-site response but a top-level navigation's (`cross_site:`, `top_level:`).
      def store_cookie(url, line, secure:, http:, cross_site: false, top_level: false)
        context = (http ? COOKIE_HTTP : 0) | (secure ? COOKIE_SECURE : 0) | (cross_site ? COOKIE_CROSS_SITE : 0) | (top_level ? COOKIE_LAX_OK : 0)
        Native.cookie_jar_set(@cookie_jar, url.to_s, line.to_s, context, cookie_now)
      end

      # Every cookie of the session gone (WebDriver "Delete All Cookies", which the WPT harness's testdriver asks for).
      def delete_all_cookies = Native.cookie_jar_clear(@cookie_jar)

      # `document.cookie` reads/writes the cookies of a document's cookie URL (`url`, Chrome's: its own, or an about:blank
      # / srcdoc frame's creator's, which the bindings find); a top-level window's about:blank one its opener's (realm
      # `realm`'s, a window realm's; this window's, another window's browser), else the session's default host's — a
      # frame's that comes to none, none (nil: no cookies).
      def document_cookie_url(url = nil, realm = nil)
        url = opener_cookie_url(realm) unless url.to_s.match?(%r{\Ahttps?://}i)
        return url if cookie_host(url)

        realm.to_i.positive? && !@runtime.window_realm_meta.key?(realm.to_i) ? nil : @default_host
      end
      private def opener_cookie_url(realm)
        rid = realm.to_i
        if rid.positive?
          meta = @runtime.window_realm_meta[rid] or return nil
          opener = meta[:opener_id].to_i
          return opener.positive? ? frame_realm_url(opener) : @current_url
        end
        handle = opener_handle
        handle && @driver.window_browser(handle)&.current_url
      end

      # (…its text: HTML's UTF-8 decode of the bytes) — in the browsing context of realm `realm`, cross-site for cookies
      # where an ancestor's document is (RFC 6265bis "site for cookies": no SameSite cookie read or stored there but a
      # None one).
      def document_cookie(url = nil, realm = nil)
        url = document_cookie_url(url, realm) or return ''
        cookies = cookie_header_for(
          url,
          secure:     secure_cookie_channel?(url),
          http:       false,
          cross_site: frame_ancestor_cross_site?(realm, url),
          lax_ok:     false
        )
        RuntimeShared.utf8_text(cookies)
      end
      def current_referer      ; @current_referer.to_s ; end
      def write_document_cookie(s, url = nil, realm = nil)
        return if s.nil? || s.empty?

        url = document_cookie_url(url, realm) or return
        store_cookie(
          url,
          s,
          secure:     secure_cookie_channel?(url),
          http:       false,
          cross_site: frame_ancestor_cross_site?(realm, url)
        )
      end

      # Web Storage's sheds for the bindings (storage.js): [localStorage's, sessionStorage's] — the engine keeps their
      # areas (storage_areas.rs), which outlive the per-visit `rebuild_ctx` (Forem caches user data in `localStorage` on
      # one page for the next).
      def storage_partitions = [@local_storage, @session_storage]

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
      # ── Frame-scoped navigation ─────────────────────────────────
      # A self-targeted link click / form submit INSIDE a `within_frame` block
      # navigates just that frame: fetch the document and rebuild the frame's
      # own realm, leaving the top page (its URL, history, status) untouched.
      # Mirrors `navigate` / `navigate_post`'s fetch + redirect-follow but
      # terminates in `reload_current_frame_realm` instead of a main-page boot.

      # A navigation's initiating document as its Referer is made of it: its URL and its referrer policy (the policy its
      # `<meta name="referrer">` sets) — the browsing context the page is in, its link or form or script the initiator
      # (`current_referrer_initiator`), or a frame's own document navigating itself (`realm_referrer_initiator`; realm 0
      # the main document). An iframe srcdoc document refers as its container document does (Referrer Policy's "determine
      # request's referrer": "while document is an iframe srcdoc document, let document be document's browsing context's
      # browsing context container's node document"), under the policy it inherits from it unless its own meta sets one.
      # One whose origin is opaque — a sandboxed document's — refers as none, a step before (`no-referrer`): its URL stays
      # the initiator its Origin and Sec-Fetch-Site are made of.
      def current_referrer_initiator = realm_referrer_initiator(@current_realm_id.to_i)
      def realm_referrer_initiator(realm_id)
        return [@current_url, main_document_referrer_policy] if realm_id.zero?
        url = frame_realm_url(realm_id)
        return [url, 'no-referrer'] if frame_document_origin_opaque?(realm_id)
        policy = frame_document_referrer_policy(realm_id)
        return [url, policy] unless url.to_s.match?(/\Aabout:srcdoc\z/i)
        container_url, container_policy = realm_referrer_initiator(@runtime.frame_realm_parent(realm_id).to_i)
        [container_url, policy.empty? ? container_policy : policy]
      end
      # The top-level browsing context navigated by the page — a link followed in it or `target=_top` from a frame
      # within it — its Referer the browsing context it was followed in.
      def navigate_top_from_page(url, blob: nil)
        navigate_top_from(@current_realm_id.to_i, current_referrer_initiator, url, blob: blob)
      end
      # …by the document of realm `realm`, its Referer `initiator` ([url, policy]): a GET, or a POST of `post` ([body,
      # content type]).
      # (…the navigation's initiator, whose site `Sec-Fetch-Site` compares, that document's URL — the page's where it is a
      # local one, about:blank's or srcdoc's, whose origin is the one that made it)
      def navigate_top_from(realm, initiator, url, post: nil, replace: false, blob: nil)
        source, policy = initiator
        site = source.to_s.match?(%r{\Ahttps?://}i) ? source : @current_url
        from_document(realm) do
          if post
            navigate_post(url, *post, referer: source, referrer_policy: policy, initiator: site, replace: replace, origin_null: frame_document_origin_opaque?(realm))
          else
            navigate(url, referer: source, referrer_policy: policy, initiator: site, replace: replace, blob: blob)
          end
        end
      end

      # An entered frame navigated (`entry`), its Referer its initiator's (`referrer`: `current_referrer_initiator`'s
      # shape) under that document's policy, determined anew at each redirect hop.
      # (…`reload`: a reload of the document it is at, whose `blob:` URL's bytes it kept — revoked since or not)
      def navigate_frame(url, depth: 0, entry: @frame_stack.last, referrer: current_referrer_initiator, reload: false)
        raise 'too many redirects' if depth > 10
        return if depth.zero? && !prompt_to_unload_frame(entry[:realm_id], entry[:parent_realm_id])

        invalidate_find_cache
        if url.to_s.match?(ABOUT_BLANK)
          reload_current_frame_realm('about:blank', '', 'text/html', entry: entry)
          return
        end
        # A `blob:` URL, which no server answers: the blob the container has its navigation load (`__csimTakeFrameNavBlob`:
        # the one it began with, a reload's the one the document was loaded of, else the one it names now in this window's
        # registry — no other window's partition) — none a failed load at the URL. A redirect to one is a network error
        # (Fetch's HTTP-redirect fetch: a location URL of no HTTP(S) scheme), its failed load committed at the URL.
        if url.to_s.match?(/\Ablob:/i)
          blob = depth.zero? ? host_blob(frame_realm_host_call(entry[:parent_realm_id], '__csimTakeFrameNavBlob', entry[:realm_id], url.to_s, reload)) : nil
          return reload_current_frame_realm(url.to_s, blob ? blob[:bytes] : '', blob ? blob[:type] : 'text/html', entry: entry)
        end
        env = rack_env_for(url, method: 'GET')
        # (…its Referer the frame document's, under its referrer policy — its `<meta name="referrer">`)
        apply_default_request_env(env, referer: compute_referrer(referrer[1], referrer[0], url))
        response = dispatch_rack_or_http(url, env, method: 'GET') or return reload_current_frame_realm(url.to_s, '', 'text/html', entry: entry)
        status, headers, body = response
        merge_set_cookie(headers, url, env)
        if (loc = redirect_location(status, headers))
          next_url = carry_fragment(url, resolve_location(loc, url))
          body.close if body.respond_to?(:close)
          return navigate_frame(next_url, depth: depth + 1, entry: entry, referrer: referrer)
        end
        if download_response?(headers)
          save_downloaded_response(url, headers, body, realm: entry[:realm_id])
          return
        end
        reload_current_frame_realm(url.to_s, read_rack_body(body), response_content_type(headers), entry: entry, csp: response_csp(headers))
      end

      def navigate_frame_post(url, body, content_type, depth: 0, entry: @frame_stack.last, referrer: current_referrer_initiator)
        raise 'too many redirects' if depth > 10
        return if depth.zero? && !prompt_to_unload_frame(entry[:realm_id], entry[:parent_realm_id])

        invalidate_find_cache
        env = rack_env_for(url, method: 'POST', input: body)
        env['CONTENT_TYPE']   = content_type.to_s.empty? ? 'application/x-www-form-urlencoded' : content_type
        env['CONTENT_LENGTH'] = body.bytesize.to_s
        apply_default_request_env(env, referer: compute_referrer(referrer[1], referrer[0], url))
        response = dispatch_rack_or_http(url, env, method: 'POST', body: body) or return reload_current_frame_realm(url.to_s, '', 'text/html', entry: entry)
        status, headers, resp_body = response
        merge_set_cookie(headers, url, env)
        if (loc = redirect_location(status, headers))
          next_url = carry_fragment(url, resolve_location(loc, url))
          resp_body.close if resp_body.respond_to?(:close)
          # 301/302/303 → GET; 307/308 preserve method + body (same as navigate_post).
          if Native.redirect_to_get(status.to_i, 'POST')
            return navigate_frame(next_url, depth: depth + 1, entry: entry, referrer: referrer)
          else
            return navigate_frame_post(next_url, body, content_type, depth: depth + 1, entry: entry, referrer: referrer)
          end
        end
        if download_response?(headers)
          save_downloaded_response(url, headers, resp_body, realm: entry[:realm_id])
          return
        end
        reload_current_frame_realm(url.to_s, read_rack_body(resp_body), response_content_type(headers), entry: entry, csp: response_csp(headers))
      end

      # Tear down a frame's realm and rebuild it from `html`, then re-point the
      # iframe element at the new realm. The iframe lives in the PARENT realm, so
      # the rebind host fn runs there. `entry` defaults to the active frame; a
      # `_parent`-targeted navigation passes an ancestor entry instead — every
      # frame below it in the stack is destroyed along with the ancestor's old
      # document, so we dispose those realms and leave `@current_realm_id` on the
      # (now-gone) current frame, surfacing StaleElement for the rest of the open
      # `within_frame` block. Its `ensure` pops back to `entry`, whose `realm_id`
      # we've updated to the rebuilt realm.
      #
      # Teardown reaches the realms on the entered `@frame_stack` (the ones a
      # find could route into). Like the self-nav path, descendant realms of the
      # rebuilt frame that were entered-then-popped earlier (so they no longer
      # sit on the stack) aren't disposed here — they linger, unreferenced and
      # un-stepped, until the next full-page rebuild's `dispose_frame_realms`. A
      # bounded per-test leak, only reachable by re-entering a sibling subframe
      # before an ancestor `_parent` nav; not worth a JS descendant walk on this
      # path's perf budget.
      def reload_current_frame_realm(url, bytes, content_type, entry: @frame_stack.last, csp: nil)
        return unless entry
        old_id = entry[:realm_id]
        parent = entry[:parent_realm_id]
        seed = frame_realm_host_call(parent, '__csimFrameSeed', entry[:iframe_handle], url.to_s, csp, navigation_sandbox(old_id)) or return
        return unless unload_frame_document(parent, old_id)

        # (…the bytes a reload of it loads again none but a blob document's, which the container kept as it took them:
        # `__csimTakeFrameNavBlob`)
        frame_realm_host_call(parent, '__csimForgetFrameLoaded', old_id) unless url.to_s.match?(/\Ablob:/i) && !bytes.to_s.empty?

        new_id = @runtime.reload_frame_realm(old_id, parent.to_i, url, document_payload(bytes), content_type, nil, seed).to_i
        return if new_id.zero?
        rebind_frame_realm(parent, entry[:iframe_handle], old_id, new_id)
        if entry.equal?(@frame_stack.last)
          entry[:realm_id]  = new_id
          @current_realm_id = new_id
        else
          # Match by object identity (the branch was chosen by `equal?`); index
          # by `==` could collide if two entries were ever structurally equal.
          idx = @frame_stack.index {|e| e.equal?(entry) }
          @frame_stack[(idx + 1)..].each {|descendant| @runtime.dispose_frame_realm(descendant[:realm_id]) }
          entry[:realm_id] = new_id
        end
        invalidate_find_cache
        settle
      end

      def rebind_frame_realm(parent_realm_id, iframe_handle, old_id, new_id)
        if parent_realm_id.nil? || parent_realm_id.zero?
          @runtime.call('__csimRebindFrameRealm', iframe_handle, old_id, new_id)
        else
          @runtime.realm_call(parent_realm_id, '__csimRebindFrameRealm', iframe_handle, old_id, new_id)
        end
      end

      # Response content-type, defaulting to text/html — its fields combined, a header value being a bare string or an
      # array of fields (Rack 3's form), as "extract a MIME type" reads the header list.
      def response_content_type(headers)
        ct = headers.find {|k, _| k.to_s.downcase == 'content-type' }&.last
        ct = header_text(ct)
        ct.empty? ? 'text/html' : ct
      end

      # (…`blob`: a `blob:` URL's blob as the navigation began — `{bytes:, type:}`, `blob_snapshot` — which a revoke after
      # it began does not take back: HTML resolves the URL's blob URL entry as it parses it)
      def navigate(url, depth: 0, referer: @current_url, referrer_policy: nil, from_history: false, is_reload: false, initiator: @current_url, site_seed: nil, replace: false, blob: nil)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
        # Before ANY of this navigation lands (see `flush_outgoing_page_init`).
        # `from_history` already flushed at its own entry point, which commits the
        # history index before it gets here.
        flush_outgoing_page_init if depth.zero? && !from_history && @timers_active
        # (…its Referer the initiating document's URL — `referer` — under that document's referrer policy, the policy its
        # `<meta name="referrer">` sets (the default where none does) read before the page goes, determined anew at each
        # redirect hop as Fetch's main fetch does; a driver's visit sends none on any hop)
        referrer_policy ||= main_document_referrer_policy if referer && depth.zero?
        hop_referer = referer && compute_referrer(referrer_policy.to_s, referer, url)
        # The document's referrer is the request's, the last hop's (a redirect determines it anew).
        @current_referer = hop_referer.to_s
        # A full-document navigate also clears the pushState transition
        # queue: any URLs we'd queued during the prior page's lifetime
        # are stale once we cross a real document boundary. The pinned
        # user-action baseline is likewise scoped to the prior document —
        # drop it so it can't match (and wrongly suppress) a transition on
        # the new page.
        if depth == 0
          @recent_urls.clear if @recent_urls
          @recent_urls_last_push_at = nil
          @action_url_baseline = nil
        end
        # While navigate is in progress (and the loaded page's bootstrap
        # JS is running synchronously inside __csimLoadDocument), any
        # `history.pushState`/`replaceState` chain belongs to that load
        # — record intermediates so a polling matcher can walk them.
        prior_navigating = @navigating
        @navigating = true unless from_history
        begin
          # `about:blank` names an empty, network-less document — there's
          # nothing to fetch. Rack::MockRequest.env_for can't parse the `about:`
          # scheme (no host/path → nil[]); route straight to an empty document.
          # `location = 'about:blank'` and navigating an iframe to about:blank
          # both land here. Mirrors rack_fetch's non-http(s) guard. (Narrow to
          # about:blank specifically — about:srcdoc carries its own markup.)
          if url.to_s.match?(ABOUT_BLANK)
            @current_url = url.to_s
            record_response(200, {'content-type' => 'text/html'})
            boot_response_into_ctx('')
            return
          end
          @history_before_navigation = nil if depth.zero?
          unless from_history || depth > 0
            capture_outgoing_form_state
            record_navigation_history({method: :get, url: url}, replace: replace)
          end
          # A `blob:` URL, which no server answers: its blob's document — wherever the window that made it is (its
          # partition's) — or, one no store resolves, a failed load at the URL (`fail_blob_document`); its history entry
          # the one above, which a traversal or a reload replays here. A redirect to one is a network error (Fetch's
          # HTTP-redirect fetch: a location URL of no HTTP(S) scheme), its failed load committed at the URL.
          if url.to_s.match?(/\Ablob:/i)
            return commit_error_document(url.to_s) unless depth.zero?
            blob ||= blob_snapshot(url)
            return blob ? boot_blob_document(url, blob[:bytes], blob[:type], flushed: true) : fail_blob_document(url)
          end
          # A controlled top-level navigation goes to the controlling SW's fetch event
          # first (mode 'navigate', dest 'document') — the registration may live in ANY
          # window's Browser (they're profile-wide; see Driver#sw_navigation_fetch).
          # respondWith serves the document; nil falls through to the network GET below.
          # Mirrors the frame-navigation model (navigate_realm_self_get).
          nav_site = widen_sec_fetch_site(site_seed, sec_fetch_site(initiator, url))
          if (sw = any_window_sw_navigation_fetch(url, is_reload: is_reload, is_history: from_history && !is_reload, dest: 'document',
                                                       referrer_source: initiator, site_seed: site_seed))
            # A network-error respondWith FAILS the navigation (the history entry above stands).
            return commit_error_document(url) if sw['networkError']
            # An SW-served response joins the same post-response pipeline as a network
            # one: a redirect is followed (re-entering SW interception at the new URL),
            # an attachment downloads — never booted as the document.
            sw_headers = sw['headers'] || {}
            if (loc = redirect_location(sw['status'].to_i, sw_headers))
              return navigate(carry_fragment(url, resolve_location(loc, url)), depth: depth + 1, referer: referer, referrer_policy: referrer_policy, initiator: initiator, site_seed: nav_site)
            end
            return download_in_place(url, sw_headers, [Base64.decode64(sw['body_b64'].to_s)]) if download_response?(sw_headers)
            @current_url = url
            record_response(sw['status'] || 200, sw_headers)
            boot_response_into_ctx(Base64.decode64(sw['body_b64'].to_s))
            return
          end
          env = rack_env_for(url, method: 'GET')
          # Top-level navigation Fetch metadata: Sec-Fetch-Site is the initiator↔target
          # relationship, widened across the redirect chain (site_seed, precomputed as
          # `nav_site` above) exactly like the frame-navigation model — the SameSite
          # cookie gate in apply_default_request_env reads it. No initiator (driver
          # visit / address bar) → 'none' (not cross-site).
          env['HTTP_SEC_FETCH_MODE'] ||= 'navigate'
          env['HTTP_SEC_FETCH_DEST'] ||= 'document'
          env['HTTP_SEC_FETCH_SITE'] ||= nav_site
          apply_default_request_env(env, referer: hop_referer)
          response = dispatch_rack_or_http(url, env, method: 'GET') or return commit_error_document(url)
          status, headers, body = response
          merge_set_cookie(headers, url, env)
          if (loc = redirect_location(status, headers))
            next_url = resolve_location(loc, url)
            # Per RFC 7231: if the original request URL had a fragment
            # and the redirect target doesn't specify one, preserve
            # the original fragment in the final URL.
            next_url = carry_fragment(url, next_url)
            body.close if body.respond_to?(:close)
            # Thread the initiator + widened site so the chain's SameSite verdict
            # latches (a same-origin nav THROUGH a cross-site hop stays cross-site).
            return navigate(next_url, depth: depth + 1, referer: referer, referrer_policy: referrer_policy, initiator: initiator, site_seed: nav_site)
          end
          # A response that downloads makes no document: a window that has one stays at it, its URL its document's
          # (Chrome: `location.href = '/dl'` on /a reports /a, and a reload after reloads /a). One that has none yet — an
          # aux window opened on a binary asset (a PDF / image `target=_blank` opens) — reports the URL it was opened on,
          # which within_window assertions read.
          return download_in_place(url, headers, body) if download_response?(headers)
          @current_url = url
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
          # No document committed (a download, a raise mid-fetch) → the page that
          # flushed is still live and still means what its timers asked for.
          restore_flushed_nav_intents if depth.zero?
        end
      end
      # A navigation's session history entry, pushed (or the current one replaced) as it begins — the history before it
      # kept, for a response that turns out to make no document (`download_in_place`).
      private def record_navigation_history(entry, replace: false)
        @history_before_navigation = [@history.dup, @history_idx] if window_has_document?
        replace ? replace_history(entry) : record_history(entry)
      end
      # A navigation's response that downloads makes no document: a window that has one stays at it — its URL and its
      # session history its document's (Chrome: `location.href = '/dl'` on /a reports /a, and a reload after reloads /a),
      # and what its flushed timers planned still stands, the page they ran in being the one that stays. One that has none
      # yet — an aux window opened on a binary asset (a PDF / image `target=_blank` opens) — reports the URL it was opened
      # on, which within_window assertions read.
      private def download_in_place(url, headers, body)
        if window_has_document?
          @history, @history_idx = @history_before_navigation if @history_before_navigation
        else
          @current_url = url
        end
        @history_before_navigation = nil
        save_downloaded_response(url, headers, body)
        restore_flushed_nav_intents
        nil
      end
      private def window_has_document?
        !(@current_url.to_s.empty? || @current_url == 'about:blank')
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
      # Whether the document's response makes it cross-origin isolated (HTML "obtain a cross-origin opener policy" and
      # "obtain an embedder policy"): `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
      # require-corp` or `credentialless` — every document here being in a secure context, as `isSecureContext` says
      # (a real browser's http://www.example.com would not be; its http://127.0.0.1 would). Not modelled: a cross-origin
      # frame's own `allow="cross-origin-isolated"` permission (it shares the top-level document's here), nor a service
      # worker's own COEP (it is never isolated here).
      private def cross_origin_isolated_response?
        policy = ->(name) { (@last_response_headers || {}).find {|k, _| k.to_s.casecmp?(name) }&.last.then { header_text(_1).split(';').first.to_s.strip } }
        policy.('cross-origin-opener-policy') == 'same-origin' && %w[require-corp credentialless].include?(policy.('cross-origin-embedder-policy'))
      end

      def boot_response_into_ctx(html)
        # (The outgoing page's due-now init ran back at the navigation's entry
        # point — `flush_outgoing_page_init`, called before anything commits.)
        # This IS the commit, so whatever that page stashed dies with it.
        @flushed_nav_intents = nil
        # The outgoing page's raced fetches die with its VM (fetch ids are per-VM) —
        # a leg delivering after this point would resolve the NEW page's same-
        # numbered fetch with the old page's response.
        reset_sw_race_state
        terminate_document_workers
        sw_unload_document_clients
        drop_document_websockets
        # (…an about:blank document's its creator's — the document that navigated to it, or a pop-up's opener: it takes
        # its creator's policy container, the policies with it)
        @runtime.cross_origin_isolated = cross_origin_isolated_response? unless @current_url.to_s.match?(ABOUT_BLANK)
        @runtime.rebuild_ctx
        # (…and what the caller's new page holds before its document loads: a blob: document's copy of its own bytes)
        yield if block_given?
        # The lifecycle steps queued on the outgoing page's event loop are the new page's to run.
        @sw_steps_queued.each do |h|
          @runtime.call('__csim_swQueueStep', h)
        end
        @sw_jobs_queued.each do |id|
          @runtime.call('__csim_swQueueJob', id)
        end
        # The service workers that outlive the navigation follow the new page's clock (timers.js `followWindowClock`).
        @runtime.call('__csimFollowWindowClock') unless @workers.empty?
        # A full page (re)build disposes every frame realm, so any active
        # `within_frame` scope is now stale — fall back to the main document.
        # Per-frame session histories are scoped to this document tree; drop them.
        reset_frame_scope
        @frame_histories       = nil
        @frame_leaving_entries = nil
        reset_timer_state
        # The response content type drives both the parser choice (XML vs HTML —
        # XHTML/XML/SVG parse case-sensitively, no html/head/body skeleton,
        # `isHtmlDocument` false) and the encoding's HTTP-charset signal.
        ct = (@last_response_headers || {}).find {|k, _| k.to_s.downcase == 'content-type' }&.last
        ct = ct && header_text(ct)
        opts = {
          'traceActive'        => !@trace.nil?,
          'timezone'           => ENV['TZ'].to_s,
          'timeTravelOffsetMs' => ((Time.now.to_f - Process.clock_gettime(Process::CLOCK_REALTIME)) * 1000).to_i,
          'url'                => @current_url.to_s,
          'html'               => document_payload(html)
        }
        opts['contentType'] = ct.to_s if ct && !ct.to_s.empty?
        # `document.lastModified` reflects the response Last-Modified header (parsed
        # to local time); absent → the current time (handled JS-side).
        lm = response_headers['Last-Modified']   # response_headers normalizes keys to Capitalized-Dash form
        lm &&= header_text(lm)
        opts['lastModified'] = lm if lm && !lm.empty?
        if @viewport_width && @viewport_height
          opts['viewportW'] = @viewport_width
          opts['viewportH'] = @viewport_height
        end
        opts['touch'] = true if @touch_input
        opts['historyState'] = @restoring_history_state unless @restoring_history_state.nil?
        csp = response_csp(@last_response_headers || {})
        opts['csp'] = csp if csp
        # (…the worker controlling it: its navigation's — not one still activating that would have handled it, whose
        # navigation went to the network, as a navigation does not yet wait for its activation)
        if @current_url.to_s.match?(%r{\Ahttps?://}i)
          controller = sw_client_controller_for(@current_url.to_s)
          controller = nil if controller && controller[1] && !@worker_init_lock.synchronize { @workers[controller[0]]&.dig(:sw_activated) }
          opts['controller'] = controller if controller
        end
        creator, @creator = @creator, nil
        if creator && @current_url.to_s.match?(ABOUT_BLANK)
          opts['creatorOrigin'] = creator[:origin]
          opts['aboutBase']     = creator[:base]
        end
        @document_handle = @runtime.call('__csimBootContext', opts).to_i
        # Drain the app's deferred external-script (chunk) boot chain to quiescence.
        # A dynamically-inserted external <script> runs async (setTimeout 0; HTML
        # "prepare the script" force-async), so a module/chunk loader's scripts
        # haven't executed when boot returns — leaving the page half-booted, where a
        # negative assertion (have_no_*) passes early or a reactive control (a toggle
        # whose handler a chunk wires up) does nothing. `run_loop_step(0)` fires only
        # ALREADY-due timers (the setTimeout(0) chunks + their .then chains, which
        # may insert further due-now chunks), NOT delayed app timers — so a test can
        # still observe the state before a delayed one (smoke_spec "has run the page
        # init a browser runs during the load, but not its later timers"). Bounded by
        # the finite pending-script count.
        BOOT_SCRIPT_DRAIN_MAX_ITER.times do
          break if @runtime.call('__csimPendingExternalScriptCount').to_i.zero?
          @runtime.run_loop_step(0, SETTLE_MAX_ITER_TASKS, yield_on_gen: false)
        end
        # The document and everything it deferred are in, so the window `load`
        # event fires — which for the MAIN document nothing ever did. Frames and
        # auxiliary windows each fired their own; a page's own
        # `window.onload` / `$(window).on('load')` init simply never ran, and an
        # app that defers its wiring to `load` (rather than DOMContentLoaded)
        # looked inert to a test.
        #
        # HERE and not inside `__csimLoadDocument`, because `load` waits for a
        # document's subresources: the deferred / async chunk scripts drained just
        # above are exactly those, and a handler that expects them has to run
        # after they do. Idempotent JS-side, so the WPT harness's own call after a
        # visit is a no-op rather than a second event.
        # A document's style sheets are part of what `load` waits for; the JS side
        # flushes their pending load tasks before dispatching (`sheetLoadTask`),
        # which is why nothing here advances the clock.
        #
        # The document, loaded, refreshes its service-worker client record (its URL may have moved since it reported
        # itself as it began loading), as a frame's does (V8Runtime).
        @runtime.call('__csim_swReportClient')
        # Marked, not fired: a `load` handler may navigate — submit a form, point an
        # iframe somewhere — and a navigation started while THIS one is still in
        # flight (`@navigating`) is not the same thing as one started from an idle
        # page. `flush_pending_window_load` fires it from the drain that ends every
        # navigation, and failing that from the next find.
        @window_load_due = true
        @polling_grace = POST_NAV_POLL_GRACE_POLLS
        # …and fired HERE for a main document, before anything pumps the task queue:
        # a browser's `load` precedes the page's own `setTimeout(0)`, and deferring
        # it to the next drain put every page's load AFTER the init it is supposed to
        # precede. An AUXILIARY window keeps the deferral — its first load belongs to
        # its opener, and consuming that one-shot here loses it entirely.
        # The window `load` this boot owes waits for the images the parse just started (HTML:
        # load fires after subresources). Give their fetch threads a short GVL-yielding window
        # to land: they overlap the boot's JS (rusty releases the GVL) and are usually done
        # already, but one that is not would slip its page's `load` past the visit and leave
        # what a post-visit read sees to thread timing. Bounded — a genuinely slow endpoint defers `load` to a
        # later drain instead of stalling the visit.
        # Delivery runs INSIDE the wait: `image_loads_pending?` counts undelivered results (it
        # only falls at delivery, deliberately — the tick gates key on it), so a park that only
        # sleeps until the deadline burns the whole budget even when every fetch landed in
        # milliseconds — measured 248 ms on every image-bearing Avo boot.
        if image_loads_pending?
          deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + IMAGE_LOAD_BOOT_BUDGET_S
          loop do
            deliver_image_loads
            break unless image_loads_pending? && Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
            sleep 0.005
          end
        end
        flush_pending_window_load unless @defer_window_load
        flush_page_init
        @load_navigations_due = true
      end

      # Run the page's own DUE-NOW init as the load ends — the `setTimeout(0)` a
      # framework queues while parsing, and the microtasks behind it.
      #
      # This is where a browser runs it: Chrome 151 on
      # `<div id=t>…</div><script>setTimeout(() => t.remove(), 0)</script>` serves a
      # document with no `#t` at all. The driver used to leave it pending and let the
      # first element READ fire it instead, which put the page's first re-render in
      # the middle of whatever the test was doing at the time — for Discourse's tag
      # list, in the middle of `all(…).map(&:text)`, detaching the elements the map
      # was walking.
      #
      # `maxMs: 0` fires only what is ALREADY due, so a `setTimeout(fn, 50)` stays
      # pending and a test can still observe the state before it.
      # KNOWN DIVERGENCE, measured: this runs BEFORE the window `load` event, and a
      # browser runs it after. Chrome 151 on a page that logs each step gives
      # `microtask, DCL, load, timeout0`; we give `microtask, DCL, timeout0, load`.
      # Both orders were tried against the conformance gate and only this one is
      # green — firing `load` here instead costs
      # `shadow-dom/…/inert-html-elements/test-001` and
      # `…/the-input-element/range-restore-oninput-onchange-event`, and draining
      # after the load event costs `…/form-submission-0/form-data-set-usv` and
      # `dom/events/event-global-is-still-set-when-coercing-beforeunload-result`.
      # The page's STATE at the end of the load is right either way; it is the
      # ordering between the two that is wrong, and the load event's own placement
      # (deferred out of the commit, see `@window_load_due`) is the knot to untie
      # before this can move.
      def flush_page_init
        return unless @timers_active

        # `maxMs: 0` — fire what is already DUE and advance the clock by nothing, so
        # a `setTimeout(fn, 50)` stays pending and a test can still observe the state
        # before it. Capped like every other drain (a page whose zero-delay timer
        # reschedules itself would otherwise burn the full 10 000-iteration budget on
        # every load: measured 33 ms per visit against 9 ms). Swallowed for the same
        # reason `flush_outgoing_page_init` swallows: a page that throws from its own
        # init has a problem, but `visit` isn't it.
        r = @runtime.run_loop_step(0, SETTLE_MAX_ITER_TASKS, yield_on_gen: false)
        @find_cache_dirty = true if r['dirtied'] || r['fired'].to_i > 0
      rescue StandardError => e
        log_console('warn', "page init failed: #{e.class}: #{e.message}")
      end

      # Run one due-now event-loop step on the page being navigated AWAY from,
      # before this navigation commits anything. Two reasons it exists, and the
      # ordering is what makes both work:
      #
      # 1. Its due-now init has persistent side effects the next page reads.
      #    forem's login redirect kicks off `fetchBaseData` — a `setTimeout(0)`
      #    (fetch.js) whose `.then` writes `current_user` to localStorage — but
      #    the interactive gen-yield `settle` bails on the first init mutation
      #    before that due-now fetch fires; without this flush the cache write is
      #    lost on rebuild and the next page (which reads it synchronously to
      #    reveal logged-in UI) renders as logged-out. `maxMs: 0` fires only
      #    ALREADY-due timers (the setTimeout(0) + its `.then` chain), NOT delayed
      #    ones, so the lazy wall-sync timer model is preserved (a freshly-loaded,
      #    not-yet-navigated-away page keeps its own pending setTimeout(0)s
      #    untouched; smoke_spec "has run the page init a browser runs during the
      #    load, but not its later timers").
      #
      # 2. Those tasks can still touch the URL, and a browser lets them — the
      #    outgoing document keeps running until the new response COMMITS.
      #    Measured (Chrome 151, a page whose timers `replaceState('/replaced')`
      #    then `pushState('/pushed')` while a slow `/arrived` is in flight):
      #    `/arrived` loads at `/arrived`, and going back from it lands on
      #    `/pushed` — the outgoing document's entries are real, they just don't
      #    move the incoming document's URL. Running here reproduces that: the
      #    mirrors (`history_state` / `history_push` / `history_go`, which all take
      #    effect IMMEDIATELY on `@current_url` and `@history`) act on the outgoing
      #    entry, and this navigation's `record_history` / `@current_url = url`
      #    then commit on top. Flushing AFTER the commit — where this used to
      #    live — let a late SPA redirect rewrite the incoming URL instead:
      #    Mastodon signs in to `/`, whose router schedules a `<Redirect to=
      #    '/home'>`, and a `visit` of a profile URL came back reporting — and
      #    rendering — `/home`.
      #
      # `location.* / reload` only STASH a Ruby-side intent, which IS moot once we
      # are leaving (the next find's `tick_real_time` would otherwise consume a
      # stray `@pending_location` and navigate off the freshly-loaded page), so
      # those slots are cleared for the step and restored after — except on the
      # paths where nothing commits, which put them back (`restore_flushed_nav_intents`).
      # Any throw is swallowed: a flaky outgoing-page timer must not abort loading
      # the next page.
      #
      # Two consequences of running here rather than at the rebuild, both intended
      # and both more browser-like: the outgoing page's due-now cookie / storage /
      # `serviceWorker.register()` writes now land BEFORE the navigation request is
      # dispatched (so the request carries what a browser's would), and
      # `capture_outgoing_form_state` sees values its timers set. One is invisible
      # rather than intended: `@navigating` is still false here, so a URL the flush
      # produces doesn't join `@recent_urls` — which is what keeps a polling
      # `have_current_path` from seeing the discarded page's URL.
      # Every "navigate later" slot a page's JS can stash into. Cleared for the
      # duration of the flush and restored after, so the outgoing page's intents
      # neither leak into the incoming page nor clobber the live one. Listed here
      # (rather than saved individually) because a re-assignment does NOT restore a
      # slot mutated IN PLACE — `@pending_window_nav` / `@pending_frame_nav` / `@pending_frame_submit` are
      # Hashes keyed by realm and the frame-reload slot is an Array.
      NAV_INTENT_SLOTS = %i[
        @pending_location @pending_location_replace @pending_location_initiator @pending_reload @pending_history_traverse
        @pending_window_nav @pending_frame_nav @pending_frame_submit @pending_page_submission
        @pending_frame_reload @pending_frame_traverse
      ].freeze
      private_constant :NAV_INTENT_SLOTS
      LOCATION_PLAN_SLOTS = %i[@pending_location_replace @pending_location_initiator].freeze
      private_constant :LOCATION_PLAN_SLOTS

      def flush_outgoing_page_init
        saved = NAV_INTENT_SLOTS.to_h {|slot| [slot, instance_variable_get(slot)] }
        NAV_INTENT_SLOTS.each {|slot| instance_variable_set(slot, nil) }
        # A same-document `history.back()` from the flushed page takes effect INLINE
        # (`history_go`), moving `@history_idx` under the navigation now committing —
        # the document would end up being the incoming page while the index pointed at
        # the entry the outgoing page stepped to, so a later `go_forward` replayed the
        # wrong entry. Chrome resolves the race the other way (measured, 151: a
        # `history.back()` fired while a slow document is in flight CANCELS that
        # navigation and traverses), but a `visit` that silently doesn't happen is
        # worse for a test driver than a dropped traversal, so the navigation wins and
        # the traversal is discarded — the same last-wins rule planned navigations use.
        @flushing_outgoing_page = true
        begin
          @runtime.run_loop_step(0, SETTLE_MAX_ITER_TASKS, yield_on_gen: false)
        rescue StandardError
          # Outgoing page is discarded by this navigation; its flush error is moot.
        ensure
          @flushing_outgoing_page = false
          # What the flush itself stashed, kept for the paths that DON'T commit a new
          # document (a `Content-Disposition: attachment` response, a raise mid-fetch):
          # there the page lives on, so its `location.href = …` must still happen.
          @flushed_nav_intents = NAV_INTENT_SLOTS.each_with_object({}) {|slot, h|
            v = instance_variable_get(slot)
            h[slot] = v unless v.nil?
          }
          saved.each {|slot, value| instance_variable_set(slot, value) }
        end
      end

      # Put back what `flush_outgoing_page_init` took from a page that turned out to
      # be staying (see above). `boot_response_into_ctx` drops the stash instead — a
      # committed navigation really does discard the document that stashed it. An
      # intent the live page has set since wins; the per-realm Hash / Array slots
      # merge, so neither side's entries are lost.
      def restore_flushed_nav_intents
        intents = @flushed_nav_intents
        @flushed_nav_intents = nil
        return if intents.nil? || intents.empty? || @restoring_flushed_nav_intents

        # (…a location's replace flag and initiator restored with the location they were planned with, whichever is taken)
        flushed_location = @pending_location.nil? && intents.key?(:@pending_location)
        intents.each do |slot, flushed|
          next if LOCATION_PLAN_SLOTS.include?(slot)

          current = instance_variable_get(slot)
          merged =
            case current
            when nil   then flushed
            when Hash  then flushed.is_a?(Hash) ? flushed.merge(current) : current
            when Array then flushed.is_a?(Array) ? flushed + current : current
            else            current
            end
          instance_variable_set(slot, merged)
        end
        LOCATION_PLAN_SLOTS.each {|slot| instance_variable_set(slot, intents[slot]) } if flushed_location
        # And run them. The flush consumed the task that stashed them, so the
        # settle that follows a user action sees nothing left to do and would
        # leave the page sitting on a redirect it has already asked for.
        @restoring_flushed_nav_intents = true
        begin
          drain_pending_navigation_once
        ensure
          @restoring_flushed_nav_intents = false
        end
      end

      # `Content-Disposition: attachment` (or any explicit filename
      # in inline form) is the canonical "save to disk" signal that
      # browsers honour. Tests that exercise CSV / PDF / etc. exports
      # use Redmine's `downloaded_file` helper to read the bytes
      # back from `tmp/downloads/`; routing the response through the
      # save path here keeps the page state unchanged (no rebuild),
      # mirroring what a real browser does after a download.
      # The filename a Content-Disposition gives (RFC 6266 §4.3): `filename*`'s ext-value (RFC 8187: its charset's bytes,
      # percent-encoded) where it decodes — in a charset Ruby knows, to valid text with no NUL — else `filename`'s, a
      # quoted-string's backslash escapes undone, its bytes UTF-8 where they are (Chrome: a raw UTF-8 name), else each
      # byte the code point it is; trimmed, and no directory of it (`../x` is `x`). '' for none, and for a name no file
      # can have (`.`, `..`, one holding a NUL). `cd` the header's text, each byte a code point (`header_text`).
      def disposition_filename(cd)
        params = disposition_params(cd.encode(Encoding::ISO_8859_1, invalid: :replace, undef: :replace).b)
        name = ext_value_text(params['filename*']) || params['filename']&.then {|plain|
          utf8 = plain.dup.force_encoding(Encoding::UTF_8)
          utf8.valid_encoding? ? utf8 : plain.dup.force_encoding(Encoding::ISO_8859_1).encode(Encoding::UTF_8)
        }
        return '' if name.nil? || name.include?("\0")
        name = File.basename(name.tr('\\', '/')).strip
        name == '.' || name == '..' ? '' : name
      end
      # …the header's parameters (after its disposition type), by name lowercased — the first of each — their values a
      # quoted-string's unescaped, a `;` or `=` inside one no separator.
      def disposition_params(bytes)
        params = {}
        bytes.scan(/;\s*([^\s=;]+)\s*=\s*("(?:[^"\\]|\\.)*"?|[^;]*)/n) do |name, value|
          value = value.strip
          value = value.delete_prefix('"').delete_suffix('"').gsub(/\\(.)/n, '\\1') if value.start_with?('"')
          params[name.downcase] ||= value
        end
        params
      end
      # …and an ext-value's text (RFC 8187): `charset'language'value`, its bytes percent-decoded in the charset — nil
      # where it is none, or its charset one Ruby does not know, or its bytes no text in it.
      def ext_value_text(ext)
        m = ext&.match(/\A([\w!#$%&+^`{}~-]+)'[^']*'(.*)\z/n) or return nil
        encoding = Encoding.find(m[1]) rescue nil
        return nil unless encoding && m[2].match?(/\A(?:[^%]|%\h\h)*\z/n)
        text = m[2].gsub(/%(\h\h)/n) { $1.hex.chr }.force_encoding(encoding)
        text.valid_encoding? && !text.include?("\0") ? text.encode(Encoding::UTF_8) : nil
      rescue EncodingError
        nil
      end

      def content_disposition_header(headers)
        value = header_field(headers, 'content-disposition')
        value && header_text(value)
      end

      def download_response?(headers)
        cd = content_disposition_header(headers)
        cd && cd.to_s.match?(/(?:^|;)\s*(attachment|filename\s*=)/i)
      end

      # …refused where the navigation's source — the realm whose document made it (`@download_source`, none for the
      # driver's own) — or its target — a frame's (`realm`, the frame realm), none for the top-level one — is sandboxed
      # against downloads: no `allow-downloads` (HTML "allowed to download", navigables.rs `download_allowed`).
      def save_downloaded_response(url, headers, body, realm: nil)
        return if body.is_a?(CutShortBody)   # the download fails: its body never came whole (Chrome)
        source = @download_source || realm
        return unless @runtime.call('__csimDownloadAllowed', source.nil? ? -1 : source.to_i, realm.nil? ? -1 : realm.to_i, navigation_sandbox(realm))

        filename = disposition_filename(content_disposition_header(headers).to_s)
        filename = File.basename(parse_url(url.to_s)&.fetch(:pathname).to_s) if filename.empty?
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

      # A Rack env for a request to `url`, a URL the URL Standard parsed. Its request target is what a server reads off
      # the request line — the path and query as the URL has them, no fragment. Rack's builder parses the URL again with
      # Ruby's URI, which refuses some of what the URL Standard keeps (`|` in a path, `{` in a fragment, a backtick in a
      # query), so it is handed a URI-legal copy, and the env then takes the target as it is.
      RACK_URI_ILLEGAL = %r{[^!*'();:@&=+$,/?\[\]A-Za-z0-9\-._~%]}n
      def rack_env_for(url, **opts)
        target = url.to_s.sub(/#.*/m, '')
        # (…what Rack's URI parser refuses escaped for it alone — a byte outside its set, a `%` that begins no escape — the
        # path and query passed on as the page wrote them, as a browser sends them)
        parseable = target.b.gsub(RACK_URI_ILLEGAL) {|c| format('%%%02X', c.ord) }.gsub(/%(?![0-9A-Fa-f]{2})/n, '%25')
        env       = Rack::MockRequest.env_for(parseable, **opts)
        if (m = target.match(%r{\A[^:/?#]+://[^/?#]*([^?#]*)(?:\?(.*))?\z}m))
          env['PATH_INFO']    = m[1].empty? ? '/' : m[1]
          env['QUERY_STRING'] = m[2].to_s
        end
        env
      end

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
        referrer = referrer_header(referer)
        env['HTTP_REFERER'] = referrer if referrer
        # Attach the TARGET host's cookies (not the document's) — SERVER_NAME is the
        # request's host — so a cross-origin request carries the right jar or none.
        # SameSite context from the request's own Fetch metadata (set by
        # navigation_request_headers before cookies attach). No metadata — a fetch, an
        # asset / ESM / beacon load — attaches every cookie here, and rack_fetch sheds
        # the cross-site ones once it knows the hop's site for cookies.
        # `csim.cookie_cross_site` is the ANCESTOR-CHAIN verdict (RFC 6265bis "site for
        # cookies"): a navigation into a frame with a cross-site ancestor is cross-site
        # for cookies even when its initiator is same-origin — while Sec-Fetch-Site
        # stays initiator-based. Cookie-only, never a header.
        cross_site = env['HTTP_SEC_FETCH_SITE'] == 'cross-site' || env['csim.cookie_cross_site'] == true
        # The Lax exception is TOP-LEVEL navigations only (dest 'document'): a cross-site
        # iframe GET is mode navigate too, but Chrome's Lax-by-default blocks it there.
        lax_ok     = env['HTTP_SEC_FETCH_MODE'] == 'navigate' && env['HTTP_SEC_FETCH_DEST'] == 'document' && env['REQUEST_METHOD'] == 'GET'
        ck = cookie_header_for(env_request_url(env), secure: env_secure_channel?(env),
                                                     cross_site: cross_site, lax_ok: lax_ok)
        if ck.empty?
          env.delete('HTTP_COOKIE')
        else
          env['HTTP_COOKIE'] = ck
        end
      end

      # Referer / Origin / Fetch-Metadata for a NAVIGATION request (a document load — form
      # submit, location set, link activation). Unlike a fetch/XHR (which carries a per-request
      # policy through rack_fetch), a navigation's request headers derive from the INITIATING
      # document: its Referrer-Policy (compute_referrer), its origin (an `Origin` header — sent
      # only on an unsafe method, i.e. a form POST, never a GET/HEAD navigation), and the
      # Fetch-Metadata triple. `dest` is 'document' for a top-level nav, 'iframe' for a subframe.
      # `site_override` / `origin_null` carry redirect-chain latched state (navigate_realm_self_*
      # thread it through each hop): Sec-Fetch-Site is the WIDEST initiator↔url relationship over the
      # whole chain (a same-site redirect keeps 'same-site' even when the final hop is same-origin),
      # and a form POST's Origin becomes the opaque 'null' once any hop has crossed origin.
      def navigation_request_headers(env, method:, initiator_url:, target:, dest:, referrer_policy: nil, user_activated: false, site_override: nil, origin_null: false)
        # Fetch metadata FIRST: apply_default_request_env's SameSite cookie gate reads
        # the request's own Sec-Fetch-Site/Mode/Dest, so they must be on the env before
        # cookies attach.
        env['HTTP_SEC_FETCH_SITE'] = site_override || sec_fetch_site(initiator_url, target)
        env['HTTP_SEC_FETCH_MODE'] = 'navigate'
        env['HTTP_SEC_FETCH_DEST'] = dest.to_s
        env['HTTP_SEC_FETCH_USER'] = '?1' if user_activated
        apply_default_request_env(env, referer: compute_referrer(referrer_policy, initiator_url, target))
        # Origin is appended to every non-GET/HEAD request (a form POST carries it; a GET navigation
        # does not). From a KNOWN initiating document it's that document's origin serialization, or
        # the literal 'null' when that origin is opaque (an about:blank / data: frame) or has been
        # tainted by a cross-origin redirect — matching the fetch path's `effective_origin`
        # convention. Omitted only when the initiator is unknown (a disposed realm → nil url).
        if initiator_url && !initiator_url.to_s.empty? && !%w[GET HEAD].include?(method.to_s.upcase)
          env['HTTP_ORIGIN'] = (!origin_null && url_origin(initiator_url)) || 'null'
        end
      end

      # Build + dispatch a navigation request (a frame/document load) — the shared core of the GET
      # self-nav, the POST self-nav, and the navigation-preload request, so all three send the SAME
      # Referer / Origin / Fetch-Metadata (dest 'iframe') and can't silently diverge. `site` is the
      # caller's already-widened Sec-Fetch-Site (threaded across the redirect chain it owns);
      # `extra_headers` carries any request-specific CGI header (the preload marker). Returns
      # [status, headers, resp_body] — the caller handles redirects / reload / the preload wire.
      # RFC 6265bis "site for cookies": a frame's cookie site folds its ANCESTOR chain.
      # A navigation into frame `realm_id` is cross-site for cookies when ANY ancestor
      # document (the frame's parents up to the top window) is cross-site with the
      # target — even if the navigation's own initiator is same-origin. Top-level
      # navigations have no ancestors and never fold (their strict/lax split is the
      # initiator-based Sec-Fetch-Site latch).
      # …and a navigation of a frame in realm `realm_id`'s document: cross-site where that document is, or an ancestor of
      # it.
      # The document a load the host makes is for — realm `realm`'s, the top-level one's for none — as a request to
      # `target_url` takes it: its URL (an about:blank / srcdoc one's its creator's, whose origin it has), whether the
      # request is cross-site for cookies (where it, or an ancestor, is: `container_cross_site?`; one of an opaque origin
      # always), and the referrer and policy it refers by — its document's `referrer_policy` and opacity the bindings
      # tell (a frame still parsing has none the host could ask), a srcdoc document its container's referrer and, with
      # none of its own, policy; an opaque one none (Referrer Policy "determine request's referrer"). Read on the main
      # thread, which a realm's URL is asked on; a frame gone, the top-level one's.
      LoadClient = Struct.new(:url, :cookie_cross_site, :referrer, :referrer_policy)
      def load_client(realm, target_url, referrer_policy: nil, opaque: false)
        rid    = realm.to_i
        policy = opaque ? 'no-referrer' : referrer_policy.to_s
        return LoadClient.new(@current_url, opaque, @current_url, policy) unless rid.positive? && (url = frame_realm_url(rid))

        referrer = url
        if url.match?(/\Aabout:srcdoc\z/i)
          referrer, container_policy = realm_referrer_initiator(@runtime.frame_realm_parent(rid).to_i)
          policy = container_policy if policy.empty?
        end
        url = referrer unless url.match?(%r{\Ahttps?://}i)
        LoadClient.new(url, opaque || container_cross_site?(rid, target_url), referrer, policy)
      end
      # A document's site for cookies (RFC 6265bis "site for cookies"): its top-level document's site where every ancestor
      # of it is of that site, else none (nil) — an about:blank / srcdoc one inheriting its creator's.
      private def site_for_cookies(realm_id)
        urls = []
        rid  = realm_id.to_i
        while rid.positive? && !@runtime.top_level_realm?(rid)
          return nil if frame_document_origin_opaque?(rid)   # (…a document of an opaque origin is of no site at all)

          urls << frame_realm_url(rid)
          rid = @runtime.frame_realm_parent(rid).to_i
        end
        site = registrable_site(rid.positive? ? frame_realm_url(rid) : @current_url) or return nil
        same = urls.all? {|u| u && !u.match?(/\Adata:/i) && (!u.match?(%r{\Ahttps?://}i) || registrable_site(u) == site) }
        same ? site : nil
      end
      # …and whether a request to `hop` a dedicated worker makes — on its own thread — is cross-site for cookies by the one
      # it was made with: false for none (not a worker's thread, a service worker).
      private def worker_cross_site?(hop)
        record = Thread.current[:csim_worker_record]
        return false unless record&.key?(:site_for_cookies)

        site = record[:site_for_cookies]
        site.nil? || registrable_site(hop) != site
      end
      private def container_cross_site?(realm_id, target_url)
        rid = realm_id.to_i
        cookie_cross_site_document?(rid.positive? ? frame_realm_url(rid) : @current_url, target_url) || frame_ancestor_cross_site?(rid, target_url)
      end
      # Whether a document of `url` (or an origin) makes a request to `target_url` under it cross-site for cookies: one
      # whose URL is not known (closed rather than open), one of an opaque origin (a `data:` document's, a sandboxed
      # one's `null`: of no site at all), one of another site.
      private def cookie_cross_site_document?(url, target_url)
        url.nil? || url == 'null' || url.to_s.match?(/\Adata:/i) || sec_fetch_site(url, target_url.to_s) == 'cross-site'
      end
      private def frame_ancestor_cross_site?(realm_id, target_url)
        rid = realm_id.to_i
        # A WINDOW realm (same-isolate popup) is itself a top-level navigable: it has
        # no ancestors of its own, and its OPENER must never fold in — the loop guard
        # stops both a popup's self-navigation (no iterations) and an iframe chain
        # inside a popup (the popup's document is compared as the chain's top, then
        # the walk ends there instead of crossing into the opener via parent 0).
        while rid.positive? && !@runtime.top_level_realm?(rid)
          parent       = @runtime.frame_realm_parent(rid).to_i
          return true if cookie_cross_site_document?(parent.positive? ? frame_realm_url(parent) : @current_url, target_url)

          rid = parent
        end
        false
      end

      def dispatch_navigation_request(url, method:, initiator:, referrer_policy:, site:, origin_null:, body: nil, content_type: nil, extra_headers: nil, dest: 'iframe', cookie_cross_site: false)
        env = rack_env_for(url, method: method, input: body || '')
        env['csim.cookie_cross_site'] = true if cookie_cross_site
        if content_type
          env['CONTENT_TYPE']   = content_type.to_s.empty? ? 'application/x-www-form-urlencoded' : content_type
          env['CONTENT_LENGTH'] = body.to_s.bytesize.to_s
        end
        navigation_request_headers(
          env,
          method:          method,
          initiator_url:   initiator,
          target:          url.to_s,
          dest:            dest,
          referrer_policy: referrer_policy,
          site_override:   site,
          origin_null:     origin_null
        )
        extra_headers&.each {|k, v| env[k] = v }
        response = dispatch_rack_or_http(url, env, method: method, body: body) or return nil
        status, headers, resp_body = response
        merge_set_cookie(headers, url, env)
        [status, headers, resp_body]
      end

      # The Navigation Preload request: a parallel GET the browser issues for a navigation whose
      # controlling SW has preload enabled, exposed to the SW as `event.preloadResponse`. It IS a
      # navigation request (dest 'iframe', mode 'navigate', the frame's Referer / Sec-Fetch-Site — so
      # the server sees exactly what a no-SW navigation would) plus the `Service-Worker-Navigation-
      # Preload` header carrying the registration's header value. The SW intercepts the FINAL URL (a
      # pre-SW network redirect already happened + widened `site_seed`), so this is a single hop — no
      # redirect loop. Returns the response wire hash for the fetch-event JSON, or `PRELOAD_NETWORK_ERROR`
      # on a network error.
      def navigation_preload_response(url, referrer_source, referrer_policy, site_seed, origin_null, header_value, dest: 'iframe', cookie_cross_site: false)
        site = widen_sec_fetch_site(site_seed, sec_fetch_site(referrer_source, url))
        response = dispatch_navigation_request(
          url,
          method:            'GET',
          initiator:         referrer_source,
          referrer_policy:   referrer_policy,
          site:              site,
          origin_null:       origin_null,
          dest:              dest,
          cookie_cross_site: cookie_cross_site,
          extra_headers:     {'HTTP_SERVICE_WORKER_NAVIGATION_PRELOAD' => header_value.to_s}
        ) or return PRELOAD_NETWORK_ERROR
        status, headers, resp_body = response
        cut_short = resp_body.is_a?(CutShortBody)
        {
          'status'     => status,
          'statusText' => RuntimeShared.utf8_text(Rack::Utils::HTTP_STATUS_CODES[status.to_i] || ''),
          # A network response's headers as every other's cross (`stringify`), less the forbidden response
          # headers no script sees (set-cookie / set-cookie2 — which Rack 2 joins with a newline).
          'headers'    => stringify(headers).reject {|k, _| Native.forbidden_response_header(k) },
          'url'        => url,
          'type'       => 'basic',
          # The UA transparently decodes a Content-Encoding'd body (gzip/deflate) before the SW's
          # `event.preloadResponse.text()` sees it — the header stays, the bytes are inflated (as the
          # regular fetch path does).
          'body_b64'   => Base64.strict_encode64(decode_content_encoding(read_rack_body(resp_body), headers)),
          # (…a body the wire cut short: what came, and then a network error as the SW reads it)
          'body_error' => (true if cut_short)
        }.compact
      rescue StandardError
        PRELOAD_NETWORK_ERROR
      end
      # A preload that failed: `event.preloadResponse` rejects (Service Workers "Handle Fetch").
      PRELOAD_NETWORK_ERROR = {'networkError' => true}.freeze

      # Fetch-Metadata `Sec-Fetch-Site`: the relationship of a request's INITIATOR to its target.
      # no initiator (a direct address-bar load) → 'none'; same (scheme,host,port) → 'same-origin';
      # same registrable site (eTLD+1) → 'same-site'; else → 'cross-site'.
      def sec_fetch_site(initiator_url, target_url)
        io = url_origin(initiator_url)
        return 'none' if io.nil?
        return 'same-origin' if io == url_origin(target_url)
        is = registrable_site(initiator_url)
        ts = registrable_site(target_url)
        is && ts && is == ts ? 'same-site' : 'cross-site'
      end

      SEC_FETCH_SITE_RANK = {'same-origin' => 0, 'same-site' => 1, 'cross-site' => 2, 'none' => 2}.freeze
      private_constant :SEC_FETCH_SITE_RANK
      # The wider (more distant) of two Sec-Fetch-Site values — used to latch the value across a
      # redirect chain (same-origin < same-site < cross-site). `nil` seed → the other value.
      def widen_sec_fetch_site(a, b)
        return b if a.nil?
        SEC_FETCH_SITE_RANK[b].to_i > SEC_FETCH_SITE_RANK[a].to_i ? b : a
      end

      # Fetch "HTTP-redirect fetch": a request's Origin opaques to 'null' once it follows a
      # cross-origin redirect WHILE ALREADY off the initiator's origin — i.e. the current URL is
      # cross-origin to BOTH the redirect target and the initiator. The FIRST cross-origin hop (still
      # on the initiator's origin) keeps the real Origin; a later hop that redirects same-origin-to-
      # current keeps it too. Monotonic: once opaque, an opaque origin is same-origin with nothing, so
      # it stays null.
      def redirect_taints_origin?(already_null, initiator_url, current_url, location_url)
        already_null ||
          (url_origin(current_url) != url_origin(location_url) && url_origin(initiator_url) != url_origin(current_url))
      end

      # The site of a URL — scheme and registrable domain — that a Sec-Fetch-Site / same-site comparison and a blob
      # URL's partition use, as storage's areas do: the engine's (realm_location.rs `site`). nil for a hostless or
      # non-http(s) URL.
      def registrable_site(url) = Native.site(url.to_s)

      # A frame's navigation that FAILED — a network error: the frame commits an error document at the target URL (an empty
      # one, as a failed `src` does), not keeping the document it unloaded.
      def commit_frame_error_document(realm_id, url, client_id)
        reload_frame_realm_by_id(realm_id, url.to_s, '', 'text/html', client_id: client_id)
      end

      # A top-level navigation that FAILED — a network error: Chrome still commits an error document at the target URL, so
      # the URL moves even though nothing loaded.
      def commit_error_document(url)
        @current_url = url
        record_response(0, {'content-type' => 'text/html'})
        boot_response_into_ctx('')
      end

      # Cross-host hop (e.g. Discourse's `discourse_connect` flow
      # redirecting to a real WEBrick on `localhost:9100`) must cross
      # the wire — Rails' router doesn't have routes for the external
      # server's paths, and the external server's redirect back to the
      # app host needs to come through @app again. Real-browser drivers
      # get this for free; we have to detect the boundary. nil for a network error (`framed_response`).
      def dispatch_rack_or_http(url, env, method: 'GET', body: nil)
        # External fetch: if the network is blocked (WebMock) or the
        # host is unreachable, fall back to @app — Rails will 404 or
        # otherwise handle it, matching the pre-cross-host behavior
        # for tests that route through an external OAuth provider URL
        # without intending the call to land.
        remote = net_http_fetch(url, env, method: method, body: body) unless url_is_local?(url)
        return nil if remote == :network_error

        response = framed_response(method, *(remote || @app.call(env))) or return nil
        status, headers, body = response
        [status, utf8_tagged_headers(headers), body]
      end

      # A body that ended before its Content-Length did: the bytes that came, and then a network error.
      CutShortBody = Struct.new(:bytes) do
        def each = yield(bytes)
      end

      # A response read as an HTTP/1.1 client reads it off the wire (RFC 9112 §6.3) — the app's, and a remote one as
      # Net::HTTP gave it (a body short of its length read as far as it came, a decoded one given its decoded length):
      # unless a Transfer-Encoding frames its body, its Content-Length values that differ are a network error (nil — a
      # navigation fails, Chrome and Firefox measured), and its body — but a HEAD's, a 1xx's, a 204's, a 205's and a
      # 304's, which have none whatever the app gave (Chrome's and Firefox's) — is as long as one says (the engine's
      # `message_length`): what is past it dropped, what falls short of it a `CutShortBody` (a fetch's body then fails as
      # it is read; a document renders what came, as Firefox does — Chrome commits an empty one).
      def framed_response(method, status, headers, body)
        return [status, headers, body] if headers.any? {|k, _| k.to_s.casecmp?('transfer-encoding') }

        fields         = headers.filter_map {|k, v| v if k.to_s.casecmp?('content-length') }
        framed, length = Native.message_length(fields.empty? ? nil : AssetCache.combined(fields.flatten))
        unless framed
          body.close if body.respond_to?(:close)
          return nil
        end
        code = status.to_i
        return [status, headers, body] if length.nil? || method.to_s.casecmp?('HEAD') || code < 200 || [204, 205, 304].include?(code)

        # (…read no further than its length: what is past it is the next message's, which may never end)
        bytes = +''
        if body.respond_to?(:each)
          body.each do |chunk|
            bytes << chunk.to_s
            break if bytes.bytesize >= length
          end
        end
        body.close if body.respond_to?(:close)
        return [status, headers, CutShortBody.new(bytes)] if bytes.bytesize < length

        [status, headers, [bytes.bytesize > length ? bytes.byteslice(0, length) : bytes]]
      end

      # A response's header values tagged by what their bytes are — UTF-8 where they are that, binary where not: a
      # binary-tagged one (a Net::HTTP-backed proxy's — rack-proxy's) is the wire's bytes all the same, and a reader takes
      # a header as text — a Timing-Allow-Origin handed to the page, a Last-Modified; one that is no UTF-8 (a Latin-1
      # filename or cookie byte), tagged UTF-8 or not, every reader takes as bytes. The app's own hash is left as it gave
      # it.
      def utf8_tagged_headers(headers)
        retag = ->(v) {
          next v unless v.is_a?(String) && (v.encoding == Encoding::BINARY || (v.encoding == Encoding::UTF_8 && !v.valid_encoding?))

          utf8 = v.dup.force_encoding(Encoding::UTF_8)
          utf8.valid_encoding? ? utf8 : (v.encoding == Encoding::BINARY ? v : v.b)
        }
        return headers unless headers.respond_to?(:each_pair) && headers.any? {|_, v| Array(v).any? {|e| !retag.(e).equal?(e) } }

        out = headers.dup
        headers.each_pair {|k, v| out[k] = v.is_a?(Array) ? v.map(&retag) : retag.(v) }
        out
      end

      # Whether this is a universal-server context (the WPT runner's wptserve shim
      # serves every host in-process). Gates cross-origin eager frame building: in
      # such a context a cross-origin iframe's content IS served locally, so it
      # eager-builds; an ordinary app leaves cross-origin frames lazy (= baseline),
      # so an external embed isn't eager-fetched — and so nothing it does at load happens until a test enters it (a
      # `parent.postMessage` from its load-time script is never posted; a test waiting on one enters the frame, or
      # serves the host locally). A simple flag, NOT per-URL —
      # url_is_local? compares only host:port (ignoring scheme) and treats a missing
      # ref origin as local, which would eager-build frames the baseline left lazy.
      def all_hosts_local? = @all_hosts_local

      # Path-only or fragment-only URLs are always against the current
      # origin. For absolute URLs, compare host:port to the cached
      # parsed @current_url (or default_host on first navigate).
      def url_is_local?(url)
        return true if @all_hosts_local
        s = url.to_s
        return true if s.empty? || s.start_with?('/', '#', '?')
        uri = parse_url(s)
        return true if uri.nil? || uri[:hostname].empty?
        ref = current_url_parts || parse_url(@default_host.to_s)
        return true if ref.nil? || ref[:hostname].empty?
        uri[:hostname] == ref[:hostname] && effective_port(uri) == effective_port(ref)
      end

      # The current URL's parts, kept while it stays the same string.
      def current_url_parts
        return nil if @current_url.nil?
        return @current_url_parts if @current_url_parts_for.equal?(@current_url)
        @current_url_parts_for = @current_url
        @current_url_parts     = parse_url(@current_url)
      end

      def effective_port(url)
        url[:port].empty? ? (url[:protocol] == 'https:' ? 443 : 80) : url[:port].to_i
      end

      # Returns a Rack-shaped triple, `:network_error` where the server
      # answered with no message to read, or `nil` if the network attempt
      # failed otherwise — the caller falls back to @app.call so
      # WebMock-blocked external URLs (Discourse's OAuth provider
      # redirects) still round-trip through Rails like before. Cookies
      # are origin-scoped: ours don't go out. No redirect-follow either
      # — navigate / rack_fetch's loop chooses per hop.
      def net_http_fetch(url, env, method: 'GET', body: nil)
        uri = uri_for(url)
        Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', open_timeout: 5, read_timeout: 30) do |http|
          req = Net::HTTP.const_get(method.to_s.capitalize).new(uri.request_uri)
          env.each_pair do |k, v|
            next unless k.is_a?(String) && k.start_with?('HTTP_') && k != 'HTTP_COOKIE' && k != 'HTTP_HOST'
            req[k.sub(/\AHTTP_/, '').split('_').map(&:capitalize).join('-')] = v.to_s
          end
          req['Content-Type'] = env['CONTENT_TYPE'] if env['CONTENT_TYPE']
          req.body = body if body && !body.empty?
          resp = http.request(req)
          # (…each name's fields as they came — Rack 3's Array for a repeated one — where `each_capitalized` joins them,
          # and two Set-Cookie fields, the first's Expires holding a comma, made one cookie)
          headers = {}
          resp.each_capitalized_name {|k| fields = resp.get_fields(k); headers[k] = fields.one? ? fields.first : fields }
          [resp.code.to_i, headers, [resp.body || '']]
        end
      rescue SystemExit, Interrupt, NoMemoryError
        raise
      rescue EOFError, Net::HTTPBadResponse, Net::HTTPHeaderSyntaxError, Zlib::Error
        # (…the server answered with no message Net::HTTP could read — closing before a status line, a malformed one, a
        # body its coding cannot be undone of: a network error, not a request for the app to serve)
        :network_error
      rescue Exception  # WebMock::NetConnectNotAllowedError descends from Exception, not StandardError
        nil
      end

      # Store a response's Set-Cookie headers under the RESPONDING host's jar (`url` is
      # the hop that produced `headers`). A cross-origin hop therefore writes its own
      # host's jar, never the document's (cors-cookies isolation).
      # True if the response carries a `WWW-Authenticate: Basic …` challenge — the only scheme the
      # transparent-auth retry in rack_fetch answers.
      def www_authenticate_basic?(headers)
        return false unless headers.is_a?(Hash)
        headers.each {|k, v| return true if k.to_s.casecmp?('www-authenticate') && header_text(v).strip.downcase.start_with?('basic') }
        false
      end

      # Is this URL a secure cookie CHANNEL? One of a potentially trustworthy origin (Secure Contexts, the engine's:
      # url_ops.rs `potentially_trustworthy` — https, wss, a loopback host or `localhost`: Chrome sets and sends Secure
      # cookies on http://localhost / 127.0.0.1, where app suites run).
      def secure_cookie_channel?(url)
        Native.potentially_trustworthy_origin(parse_url(url.to_s)&.fetch(:origin).to_s)
      end

      # A response's Set-Cookie fields stored for `url` — one cookie each (Rack 2 joins them with a newline, Rack 3 gives
      # an Array; splitting first keeps the second of two, Rails' session cookie beside `remember_user_token`) — for the
      # request `env` made, whose site for cookies (the one its cookies were sent by, where a fetch worked it out:
      # `csim.cookie_site`; else its Fetch metadata's) says whether it was cross-site, and whether a top-level navigation
      # (no metadata: same-site).
      def merge_set_cookie(headers, url, env = nil)
        sc = header_field(headers, 'set-cookie')
        return if sc.nil? || sc.empty?

        url = document_cookie_url unless cookie_host(url)
        secure     = secure_cookie_channel?(url)
        site       = env && (env['csim.cookie_site'] || env['HTTP_SEC_FETCH_SITE'])
        cross_site = !env.nil? && (site == 'cross-site' || env['csim.cookie_cross_site'] == true)
        top_level  = !env.nil? && (env['csim.cookie_top_level'] == true ||
                                   (env['HTTP_SEC_FETCH_MODE'] == 'navigate' && env['HTTP_SEC_FETCH_DEST'] == 'document'))
        (sc.is_a?(Array) ? sc : sc.split("\n")).each do |line|
          store_cookie(url, line, secure: secure, http: true, cross_site: cross_site, top_level: top_level)
        end
      end

      # Header names/values are BYTE sequences (RFC 9110), and script reads them
      # isomorphic-decoded — each byte the code point it is (Fetch's header list,
      # Chrome measured: UTF-8 `café` reads `cafÃ©`, a lone 0xE9 `é`). Per-value HTTP
      # -whitespace normalization happens upstream, BEFORE duplicate values are
      # combined (WptRunner.combine_headers) — not here, where a combined value like
      # `", "` (two empty fields) would wrongly lose its trailing space. An
      # Array-valued header (a Rack app emitting a repeated field) is combined with
      # `, ` — the WHATWG "combine" separator getAllResponseHeaders exposes, matching
      # both real browsers and the harness's combine_headers.
      def stringify(headers)
        headers.each_with_object({}) {|(k, v), out| out[k.to_s] = header_text(v) }
      end

      # A response's header `name`, by its name ASCII case-insensitively — a Rack 2 app may spell it any way — or nil.
      def header_field(headers, name)
        headers&.each {|key, value| return value if key.to_s.casecmp?(name) }
        nil
      end

      # …a header's value as script reads it: its fields combined (AssetCache.combined: each without the HTTP whitespace
      # around it), each byte the code point it is.
      def header_text(value)
        AssetCache.combined(value).to_s.b.force_encoding(Encoding::ISO_8859_1).encode(Encoding::UTF_8)
      end
      # …and a response's Content-Security-Policy as script reads it — its headers' fields joined, none where it has none.
      def response_csp(headers)
        csp = headers.select {|k, _| k.to_s.casecmp?('content-security-policy') }.map {|_, v| header_text(v) }
        csp.join(',') unless csp.empty?
      end

      # The Fetch "redirect status" set — ONLY these are followed. 300 (multiple
      # choice), 304 (not modified), 305/306 (deprecated) are NOT redirects: the 3xx
      # response is returned to the caller as-is (xhr send-redirect basics).
      REDIRECT_STATUSES = [301, 302, 303, 307, 308].freeze
      # Statuses whose response has no body (Fetch "null body status") — the body is dropped
      # and response.body is null (response-null-body). (101 is unreachable here.)
      NULL_BODY_STATUSES = [204, 205, 304].freeze
      # Request-body headers removed when a redirect nulls the body (method → GET).
      REDIRECT_DROPPED_HEADERS = %w[content-encoding content-language content-location content-type content-length].freeze
      def redirect_location(status, headers)
        return nil unless REDIRECT_STATUSES.include?(status.to_i)
        loc = location_field(headers)
        # A blank (or absent) Location has no FOLLOWABLE target: an empty value parses back
        # to the current URL, so following it would just self-redirect. Return nil so a
        # caller renders the 3xx as-is rather than looping — the several navigation handlers
        # rely on this. (The fetch redirect loop recognizes a present-but-empty Location
        # separately and turns it into a network error per Fetch — see rack_fetch.)
        loc unless loc.to_s.empty?
      end

      # A response's Location, as Fetch's "location URL" extracts it: its field — Rack 3 permits an Array of them — or ''
      # for more than one, which the one value Location takes cannot be ("extract header list values": failure; Chrome's
      # ERR_RESPONSE_HEADERS_MULTIPLE_LOCATION) and so has no followable target; nil for none (an empty Array too).
      def location_field(headers)
        loc = header_field(headers, 'location')
        return loc unless loc.is_a?(Array)
        return nil if loc.empty?
        loc.uniq.one? ? loc.first : ''
      end

      # …parsed as the page parses a URL (url_ops.rs): Ruby's URI refused what the URL Standard keeps, and the URL came
      # back unresolved (`location.href = '/a|b'` left `current_url` the bare path).
      def resolve_against_current(url, use_base: false)
        # Inside a `within_frame` block the "current document" is the frame's,
        # so links / form actions resolve against the frame's URL + <base href>.
        doc_url = current_browsing_context_url || @default_host
        # The document's base URL — its `<base href>`'s — when the page's own links / form actions are being resolved,
        # there being a document (before the first visit there is only the empty one, at about:blank); `visit` passes no
        # `use_base`, so an address-bar navigation reaches the URL the test typed.
        base = (use_base && current_browsing_context_url && document_base_url) || doc_url
        parse_url(url.to_s, base)&.fetch(:href) || url
      end

      # The active document's base URL (the engine's, as `document.baseURI` reads it) — routed to the current frame realm
      # inside `within_frame`, else the main document — or nil for none.
      def document_base_url
        url = dom_call('__csimBaseURL').to_s
        url.empty? ? nil : url
      end

      # Fetch "CORS-safelisted method" / "…request-header", the engine's (fetch_rules.rs) as the page's are: a request is
      # "simple" (no preflight) iff its method is safelisted AND every author header is — a safelisted name with a value
      # that keeps it so (Content-Type only a urlencoded / multipart / text/plain one, no CORS-unsafe byte, 128 bytes at
      # most).

      # The sorted, lowercased author header names that are NOT CORS-safelisted. A
      # safelisted NAME still counts as unsafe when its VALUE fails the safelisting (an
      # unsafe byte / over-128-byte length / non-safelisted Content-Type essence). These
      # are echoed in Access-Control-Request-Headers for the preflight and must be covered
      # by Access-Control-Allow-Headers.
      def cors_unsafe_headers(headers)
        (headers || {}).filter_map {|k, v|
          name = k.to_s.downcase
          next if name.start_with?('x-csim') || name == 'content-length'
          Native.cors_safelisted_request_header(name, v.to_s) ? nil : name
        }.uniq.sort
      end

      def cors_unsafe_request?(method, headers)
        !Native.cors_safelisted_method(method.to_s.upcase) || !cors_unsafe_headers(headers).empty?
      end

      # Fetch "CORS check" on a cross-origin response: it must allow the request's
      # (effective) origin via Access-Control-Allow-Origin. A NON-credentialed request
      # accepts `*` or the exact origin; a CREDENTIALED one (withCredentials) forbids
      # `*` — the ACAO must be the exact origin AND Access-Control-Allow-Credentials
      # must be `true` (access-control-and-redirects-async-same-origin credentials cases).
      def cors_response_ok?(resp_headers, origin, credentialed)
        acao = cors_header(resp_headers, 'access-control-allow-origin')
        return false if acao.nil?
        if credentialed
          return false unless acao == origin
          cors_header(resp_headers, 'access-control-allow-credentials').to_s.downcase == 'true'
        else
          acao == '*' || acao == origin
        end
      end

      # Whether a URL carries userinfo (`user[:password]@`). A CORS request to such a
      # URL is a network error (access-control-and-redirects "user info" subtest).
      def url_has_userinfo?(url)
        u = parse_url(url.to_s)
        !u.nil? && !(u[:username].empty? && u[:password].empty?)
      end

      # An author-set conditional header means the CALLER is doing its own revalidation,
      # so the UA cache must step aside: the request reaches the origin and the server's
      # own 304/200 decision is returned (send-conditional), not a cached hit.
      CONDITIONAL_REQUEST_HEADERS = %w[if-none-match if-modified-since if-match if-unmodified-since if-range].freeze
      def request_has_conditional_headers?(headers)
        headers.is_a?(Hash) && headers.any? {|k, _| CONDITIONAL_REQUEST_HEADERS.include?(k.to_s.downcase) }
      end

      # Run the CORS preflight unless a cached result already covers this request (Fetch
      # "CORS-preflight cache"): a prior preflight to the same (origin, url) within its
      # Access-Control-Max-Age that allows this method + headers lets the actual request
      # skip the OPTIONS (access-control-basic-allow-preflight-cache). Returns false (=
      # network error) only when a fresh preflight is needed AND fails.
      def cors_preflight_ok?(target, method, headers, req_origin, credentialed, referer)
        return true if cors_preflight_cached?(target, req_origin, method, headers, credentialed)
        result = cors_run_preflight(target, method, headers, req_origin, credentialed, referer)
        return false unless result
        # Cache the grant for Max-Age seconds so a covered follow-up skips the preflight.
        # The key is (origin, url, credentialed): a credentialed grant (ACAO echoing the
        # origin, no `*` matching) can't cover an uncredentialed follow-up or vice versa,
        # so the two are cached apart. Expiry uses the REAL monotonic clock (not the
        # virtual one), so a test that virtual-sleeps past Max-Age to force a re-preflight
        # isn't caught yet.
        @cors_preflight_cache[[req_origin, target, credentialed]] = result.merge(stored_at: Process.clock_gettime(Process::CLOCK_MONOTONIC)) if result[:max_age].positive?
        true
      end

      # Whether a cached preflight grant covers this request (not expired + method/headers
      # allowed). A method/header the cache doesn't cover — or an expired entry — forces a
      # fresh preflight (cache-invalidation-by-method / -header / -timeout).
      def cors_preflight_cached?(target, req_origin, method, headers, credentialed)
        entry = @cors_preflight_cache[[req_origin, target, credentialed]]
        return false unless entry
        return false if Process.clock_gettime(Process::CLOCK_MONOTONIC) - entry[:stored_at] >= entry[:max_age]
        cors_grant_allows?(entry[:methods], entry[:headers], method, cors_unsafe_headers(headers), credentialed)
      end

      # `Authorization` is Fetch's sole "CORS non-wildcard request-header name": a preflight
      # `Access-Control-Allow-Headers: *` never covers it — it must be listed by name — even
      # for an uncredentialed request (cors-preflight "authorization not covered by wildcard").
      CORS_NON_WILDCARD_REQUEST_HEADERS = %w[authorization].freeze

      # Does a preflight grant (its Access-Control-Allow-Methods / -Headers) cover this
      # request: the method is allowed / `*` / CORS-safelisted, and every unsafe header is
      # allowed / `*`. Shared by the fresh-preflight accept check and the cache-hit check.
      # For a CREDENTIALED request the wildcard loses its meaning — Fetch's "CORS-preflight
      # fetch" matches `*` against no method/header when credentials mode is include, so a
      # non-listed method or unsafe header is rejected (cors-preflight-star credentialed).
      def cors_grant_allows?(allow_methods, allow_headers, method, unsafe_headers, credentialed = false)
        # The method match is byte-CASE-SENSITIVE (Fetch normalizes the request method but
        # compares it verbatim against Access-Control-Allow-Methods): `delete` in the grant
        # does not cover a `DELETE` request. Safelisted GET/HEAD/POST pass regardless
        # (they're always normalized to upper-case) (cors-preflight-star method-case).
        m = method.to_s
        method_ok = allow_methods.include?(m) || Native.cors_safelisted_method(m) || (!credentialed && allow_methods.include?('*'))
        return false unless method_ok
        wildcard_headers = !credentialed && allow_headers.include?('*')
        unsafe_headers.all? {|h|
          allow_headers.include?(h) || (wildcard_headers && !CORS_NON_WILDCARD_REQUEST_HEADERS.include?(h))
        }
      end

      # Fetch "CORS-preflight fetch": send an OPTIONS with Access-Control-Request-Method
      # / -Headers + Origin; on success (ok-status, ACAO match, and the grant covers the
      # method + unsafe headers) return the grant {methods, headers, max_age} for the
      # cache, else nil. A credentialed preflight additionally requires the response to
      # allow credentials (ACAC:true) and forbids `*` in the origin/method/header grants.
      def cors_run_preflight(target, method, headers, req_origin, credentialed, referer)
        unsafe = cors_unsafe_headers(headers)
        env    = rack_env_for(target, method: 'OPTIONS')
        env['REQUEST_METHOD'] = 'OPTIONS'
        # The preflight's Referer is the request's referrer under its referrer policy —
        # the SAME value the actual request sends (computed by the caller), not the raw
        # document URL (cors-preflight-referrer).
        apply_default_request_env(env, referer: referer, force: false)
        # A CORS-preflight is a fetch, so it carries fetch's default `Accept: */*` (NOT
        # the navigation Accept apply_default_request_env sets) — some handlers reject a
        # preflight whose Accept isn't */* (preflight.py).
        env['HTTP_ACCEPT'] = '*/*'
        # A CORS-preflight is always uncredentialed — it carries no cookies, even when the
        # actual request that follows is credentialed.
        env.delete('HTTP_COOKIE')
        env['HTTP_ORIGIN'] = req_origin
        # Access-Control-Request-Method carries the request's (already-normalized) method
        # VERBATIM — `patch` stays `patch`, matching the byte-case-sensitive grant check.
        env['HTTP_ACCESS_CONTROL_REQUEST_METHOD'] = method.to_s
        env['HTTP_ACCESS_CONTROL_REQUEST_HEADERS'] = unsafe.join(',') unless unsafe.empty?
        response = dispatch_rack_or_http(target, env, method: 'OPTIONS', body: nil) or return nil
        status, ph, pbody = response
        pbody.close if pbody.respond_to?(:close)
        # A slow preflight counts toward the client's timeout too (timeout-multiple-fetches).
        Thread.current[:csim_fetch_server_delay_ms] += server_delay_ms_of(ph) if Thread.current[:csim_fetch_server_delay_ms]
        return nil unless (200..299).include?(status.to_i)
        acao = cors_header(ph, 'access-control-allow-origin')
        # A credentialed preflight can't be allowed by the wildcard origin and must carry
        # Access-Control-Allow-Credentials: true (cors-preflight-star credentialed).
        return nil unless credentialed ? acao == req_origin : (acao == '*' || acao == req_origin)
        return nil if credentialed && cors_header(ph, 'access-control-allow-credentials') != 'true'
        allow_methods = cors_list(cors_header(ph, 'access-control-allow-methods'))
        allow_headers = cors_list(cors_header(ph, 'access-control-allow-headers')).map(&:downcase)
        # Fetch "extract header list values" fails when a grant contains a malformed token
        # (`Access-Control-Allow-Methods: Bad value` — a space isn't a tchar), and a failed
        # extraction is a network error (cors-preflight-response-validation). Methods and
        # header names are both HTTP tokens; `*` is a valid tchar so the wildcard passes.
        # (…each an HTTP token — a valid method or field-name — the engine's: fetch_rules.rs)
        return nil unless (allow_methods + allow_headers).all? {|t| Native.http_token(t) }
        return nil unless cors_grant_allows?(allow_methods, allow_headers, method, unsafe, credentialed)
        {methods: allow_methods, headers: allow_headers, max_age: cors_header(ph, 'access-control-max-age').to_i}
      end

      # The response headers a cross-origin "cors" response exposes to getResponseHeader /
      # getAllResponseHeaders: the CORS-safelisted set plus any named in Access-Control
      # -Expose-Headers. `*` exposes every header, but ONLY for a non-credentialed response;
      # with credentials the wildcard loses its meaning and matches a header literally named
      # `*` (cors-expose-star "only matches literally").
      # The virtual server delay a response carries (X-Csim-Server-Delay-Ms, ms), 0 if none.
      def server_delay_ms_of(headers)
        return 0 unless headers.is_a?(Hash)
        pair = headers.find {|k, _| k.to_s.casecmp?('x-csim-server-delay-ms') }
        pair ? header_text(pair.last).to_i : 0
      end

      def cors_exposed_headers(headers, credentialed = false)
        # set-cookie / set-cookie2 are forbidden response-header names — NEVER exposed to
        # script, even when explicitly named in Access-Control-Expose-Headers or covered by
        # `*` (cors-filtering "header is forbidden"). x-csim-status-text is our internal
        # reason-phrase sentinel (response_hash lifts it into statusText, which IS exposed
        # cross-origin, then strips it from the script-visible map), so it must survive.
        expose = cors_list(cors_header(headers, 'access-control-expose-headers')).map(&:downcase)
        return headers.reject {|k, _| Native.forbidden_response_header(k.to_s) } if !credentialed && expose.include?('*')

        # (…a CORS-safelisted response-header name always exposed — the engine's table — and those named)
        allowed = expose + ['x-csim-status-text']
        headers.select {|k, _|
          name = k.to_s
          (Native.cors_safelisted_response_header(name) || allowed.include?(name.downcase)) && !Native.forbidden_response_header(name)
        }
      end

      # Case-insensitive response-header lookup + comma-list split for the CORS checks.
      def cors_header(headers, name)
        pair = headers.find {|k, _| k.to_s.downcase == name }
        pair ? header_text(pair.last) : ''
      end

      def cors_list(value)
        value.to_s.split(',').map(&:strip).reject(&:empty?)
      end

      # The origin of a URL — `scheme://host[:port]` with the default port (80/443)
      # elided — for the CORS same/cross-origin comparison. nil for a non-http(s) or
      # unparseable URL (about:blank / data: / a relative current_url) so CORS never
      # treats those as a comparable origin.
      def url_origin(url)
        # (…serialized by the parser: scheme and host lowercased, a default port dropped)
        u = parse_url(url.to_s)
        u && %w[http: https:].include?(u[:protocol]) ? u[:origin] : nil
      end

      def carry_fragment(from_url, to_url)
        _, from = split_fragment(from_url.to_s)
        to, own = split_fragment(to_url.to_s)
        own || from.nil? || from.empty? ? to_url : "#{to}##{from}"
      end

      # Trace-wrap layer: prepended so the canonical method bodies above
      # stay un-instrumented and a no-trace caller pays only the
      # `record_action` early-exit. `super` forwards to the real impl
      # within the `record_action` block, which handles begin/finish
      # step bookkeeping + on-failure DOM snapshot.
      module RecordedActions
        def visit(url, referer: nil, referrer_policy: nil, initiator: nil)
          driver_action(:visit, "visit #{url}") { super }
        end
        def refresh
          driver_action(:refresh, 'refresh') { super }
        end
        def go_back
          driver_action(:go_back, 'go_back') { super }
        end
        def go_forward
          driver_action(:go_forward, 'go_forward') { super }
        end
        def click(handle, keys = [], **opts)
          driver_action(:click, -> { "click #{describe_node_handle(handle)}" }) { super }
        end
        def set_value_with_events(handle, value)
          driver_action(:set, -> { "set #{describe_node_handle(handle)} = #{value.inspect[0, 80]}" }) { super }
        end
        def send_keys(handle, keys)
          driver_action(:send_keys, -> { "send_keys #{describe_node_handle(handle)} #{keys.inspect[0, 80]}" }) { super }
        end
        def select_option(handle)
          driver_action(:select, -> { "select #{describe_node_handle(handle)}" }) { super }
        end
        def unselect_option(handle)
          driver_action(:unselect, -> { "unselect #{describe_node_handle(handle)}" }) { super }
        end
        def submit_form(handle)
          driver_action(:submit, -> { "submit #{describe_node_handle(handle)}" }) { super }
        end

        # A driver's action recorded, and the navigations the documents it loaded planned as they loaded taken as it
        # ends (`take_load_navigations`).
        private def driver_action(kind, description)
          result = record_action(kind, description) { yield }
          take_load_navigations
          result
        end
      end
      prepend RecordedActions
    end
  end
end
