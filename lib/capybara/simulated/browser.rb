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
require 'uri/idna'   # WHATWG/UTS46 domain-to-ASCII/Unicode (uri-idna gem)
require 'zlib'
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
      SETTLE_DRAIN_MS = 32
      SETTLE_MAX_ITER = 10
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

      def initialize(app, driver: nil, js_engine: nil, cookies: nil, local_storage: nil, cache_storage: nil, all_hosts_local: nil)
        @app                          = app
        @driver                       = driver
        @all_hosts_local_override     = all_hosts_local
        @runtime                      = build_runtime(js_engine)
        # Per-poll clock decisions cached at construction (CLAUDE.md rule 3 — the
        # runtime type + env are fixed for the session): the wall-sync escape
        # hatch and whether the runtime exposes the fast-forward timer query.
        @clock_wall                   = !ENV['CSIM_CLOCK_WALL'].nil?
        @runtime_supports_ff          = @runtime.respond_to?(:next_timer_delay_ms)
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
        # Cookies + localStorage are origin-shared in real browsers —
        # the Driver injects the jars so aux windows (per-window VMs)
        # see the same auth state and storage as the primary. Tests
        # without a Driver (gem-internal callers) get fresh jars.
        @cookies                      = cookies       || {}
        @local_storage                = local_storage || {}
        # Cache Storage is origin-shared like localStorage (the Driver owns the store
        # and injects it into every window Browser), origin-partitioned within.
        @cache_storage                = cache_storage || {}
        @session_storage              = {}
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
        @last_tick_ts                 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @polling_grace                = nil
        @last_polled_gen              = nil
        @idle_settle_polls            = 0
        @ticking                      = false
        @history                      = []
        @history_idx                  = -1
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
        @websocket_seq        = 0
        @websocket_threads    = {}
        @websocket_sockets    = {}   # id → csim's socket end (main thread owns this hash)
        @websocket_app_sockets = {}  # id → the app's hijack end (closed on teardown)
        @websocket_queue      = Thread::Queue.new
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
        # Web Workers — per-Browser handle counter, per-worker
        # {thread, inbox} pair, and a shared outbox the main settle
        # drains via `__csim_deliverWorkerMessages`. Each worker
        # thread owns its own V8 Context / QuickJS VM (real isolate);
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
        # SW navigation-interception state. `@sw_registrations` mirrors scope-href → active
        # worker handle (from the client lifecycle) so a navigation fetched Ruby-side — before
        # the destination realm's JS exists — can find its controlling SW; it survives the
        # per-visit rebuild_ctx (unlike the per-realm JS registrations Map). A navigation fetch
        # is awaited SYNCHRONOUSLY on `@sw_nav_outbox` (a dedicated queue, off the general outbox)
        # keyed by a NEGATIVE `@sw_nav_seq` id so it never mixes with client-fetch replies.
        @sw_registrations = {}
        # clients.claim() events that arrived before their scope was mirrored into @sw_registrations
        # (activate→claim() races the client-side lifecycle) — buffered here, flushed by sw_register_scope.
        @sw_pending_claims = []
        @sw_nav_outbox    = Thread::Queue.new
        @sw_nav_seq       = 0
        # Service-worker Client registry: realm id → {handle, rec} for every
        # controlled frame/window client, mirrored into the SW's clientsById so
        # matchAll / getClientByURL see the real set. `@sw_realm_controller` records
        # each realm's controller so an opaque child (about:blank / srcdoc) inherits
        # it. Both keyed by realm id, cleared when the last worker exits.
        @sw_clients          = {}
        @sw_realm_controller = {}
        # Cross-isolate MessagePort channels: channel id → {realm:, sw:} endpoints. A port
        # transferred between a client realm and a worker/SW isolate registers both ends here;
        # the browser relays each side's postMessage to the other. Cleared with the workers.
        @port_channels       = {}
        # Workers whose initial script hasn't finished running yet. A worker that
        # posts immediately on spawn (no main->worker message first) would leave
        # `@worker_in_flight` at 0, so `worker_pending?` would be false in the gap
        # between spawn and that first post — and settle / tick_real_time would
        # stop waiting before the message lands. Count spawned-but-not-initialised
        # workers so the async drain holds until the initial script has run.
        @worker_initializing = 0
        @worker_init_lock = Mutex.new
        # Cross-isolate `blob:` store. Worker isolates can't see the
        # main scope's `__csimBlobs` Map, so we mirror bytes here and
        # workers resolve them through a host fn.
        @blob_registry = {}
        @blob_registry_lock = Mutex.new
        # url => owning worker handle, for blob URLs created INSIDE a worker. A
        # worker's blob URL store dies with it, so terminating the worker revokes
        # them (url-lifetime "Terminating worker revokes its URLs").
        @blob_owners = {}
        # Postmessage transferable-buffer store. Large Uint8Array /
        # ArrayBuffer payloads cross isolates as a Ruby-side byte ID
        # rather than a JSON base64 string, so peak JS heap stays flat.
        @transfer_buffer_lock = Mutex.new
        @transfer_buffers     = {}
        @transfer_buffer_seq  = 0
        # Per-font ascent/descent probe cache for canvas text (render_text is
        # worker-reachable via OffscreenCanvas, like decode_image).
        @font_vmetrics_lock   = Mutex.new
        @font_vmetrics        = {}
        # Zero-copy postMessage transfer tokens (rusty_racer >= 0.1.6
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
      end

      # Worker thread polling and termination intervals — split so a
      # tuning change to one doesn't accidentally rebind the other.
      WORKER_POLL_INTERVAL     = 0.05
      # Max wall time settle blocks on a worker thread's outbox per call while it processes an
      # inbound message / fetch (releasing the GVL so it runs). Bounded so a genuinely stuck worker
      # can't hang settle — the outer poll loop re-drives across calls.
      WORKER_ROUND_TRIP_BUDGET = 1.0
      WORKER_TERMINATE_GRACE   = 0.05
      # Per-frame GVL yield (run_event_loop_frame) while a worker thread is alive, so it gets a clean
      # slice for cross-isolate work (transferIn / message replies) instead of being starved by the
      # phase-1 spin. 0.3ms is the empirical floor for a deterministic cross-isolate transfer reply;
      # 0.5ms adds margin for machine variance while staying cheap (only paid on worker/SW files).
      WORKER_GVL_YIELD         = 0.0005
      # Client-realm handler for each streaming respondWith frame kind (see deliver_worker_messages
      # + sw-client.js). `fr_start` builds a ReadableStream-backed Response; `fr_chunk` enqueues;
      # `fr_close` / `fr_error` close / error the body stream.
      STREAM_FRAME_FNS = {
        'fr_start' => '__csim_swFetchStreamStart',
        'fr_chunk' => '__csim_swFetchStreamChunk',
        'fr_close' => '__csim_swFetchStreamClose',
        'fr_error' => '__csim_swFetchStreamError'
      }.freeze
      private_constant :WORKER_POLL_INTERVAL, :WORKER_ROUND_TRIP_BUDGET, :WORKER_TERMINATE_GRACE, :WORKER_GVL_YIELD, :STREAM_FRAME_FNS

      # `js_engine` picks the JS runtime: `:v8` (rusty_racer, fastest
      # per-spec) or `:quickjs` (quickjs.rb, smaller per-VM footprint —
      # wins on parallelism). Both gems are soft dependencies; pass nil
      # to auto-select whichever is installed.
      ENGINE_GEM = {v8: %w[rusty_racer], quickjs: %w[quickjs]}.freeze
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

      # `CSIM_JS_ENGINE` forces the engine (overriding auto-detect); otherwise
      # iterate `JS_ENGINES` in preference order — V8 first because JIT wins
      # per-spec wall time, QuickJS second when only the smaller-footprint
      # engine is installed.
      private def detect_js_engine
        if (env = ENV['CSIM_JS_ENGINE'].to_s) && !env.empty?
          sym = env.to_sym
          return sym if JS_ENGINES.include?(sym)
          raise ArgumentError, "unknown CSIM_JS_ENGINE #{env.inspect}; expected one of #{JS_ENGINES.inspect}"
        end
        JS_ENGINES.find {|e| ENGINE_GEM.fetch(e).any? {|g| Gem.loaded_specs.key?(g) } } ||
          raise(LoadError, "capybara-simulated needs a JS engine: add one of #{ENGINE_GEM.values.map {|gems| "`gem '#{gems.first}'`" }.join(' / ')} to your Gemfile")
      end

      # ── Capybara DSL surface ────────────────────────────────────

      # Address-bar navigation: no Referer, and relative paths resolve
      # against the host root (not the current page's directory).
      def visit(url, referer: nil)
        navigate(resolve_visit_url(url), referer: referer)
      end

      URL_UNSAFE_CHARS = %r{[^!*'();:@&=+$,/?#\[\]A-Za-z0-9\-._~%]}n.freeze
      private_constant :URL_UNSAFE_CHARS

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
          host_root =
            begin
              u = URI.parse(@current_url.to_s)
              if u.opaque || u.host.nil?
                @default_host
              else
                u.path = ''; u.query = nil; u.fragment = nil
                u.to_s
              end
            rescue URI::InvalidURIError
              @default_host
            end
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
          # Per-frame realms are a V8-engine feature; QuickJS has no nested
          # browsing context to route into. Distinguish that (unsupported
          # engine) from a frame that simply failed to build (below), so the
          # error doesn't misattribute a load failure to the engine.
          unless @runtime.supports_frames?
            raise Capybara::Simulated::FrameNotSupported,
              'within_frame needs a per-frame browsing context, which only the ' \
              'V8 (rusty_racer) engine provides; QuickJS keeps a same-realm fallback.'
          end
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

      # Does a link/form `target` load into the CURRENT frame? Empty or `_self`
      # do; `_top` / `_blank` / `_parent` / a named context do not.
      def frame_self_target?(target)
        t = target.to_s.downcase
        t.empty? || t == '_self'
      end

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
        return @frame_stack[-2] if target.to_s.downcase == '_parent' && @frame_stack.size >= 2
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
          raise unless syntax_or_invalid_selector_error?(e)
          []
        end
      end

      def find_first_css(css, context_handle = nil)
        s = css.to_s
        find_with_timer_fallback(:css_first, s, context_handle) do
          h = dom_call('__csimQueryOne', context_handle || current_document_handle, s).to_i
          h.zero? ? nil : h
        rescue StandardError => e
          raise unless syntax_or_invalid_selector_error?(e)
          nil
        end
      end

      # JS-side selector parser throws a `DOMException('csim: …',
      # 'SyntaxError')`. The JS engine surfaces it as a `…::SyntaxError`
      # (QuickJS via dynamic-named class) or, under V8, a
      # `RustyRacer::RuntimeError` whose message is `"SyntaxError: csim: …"`.
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
          dom_call('__csimEvaluateXPath', xpath_str, context_handle || 0).to_a
        end
      end

      def find_with_timer_fallback(kind, arg, ctx)
        tick_real_time if timer_wait_elapsed?
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
        worker_pending? || event_source_pending? || hijack_fetch_pending? || window_message_pending? || websocket_pending?
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

      def text(handle)        = dom_call('__csimText', handle).to_s
      def tag(handle)         = dom_call('__csimTag', handle).to_s
      def attr(handle, name)  = dom_call('__csimAttr', handle, name.to_s)
      def inner_html(handle)  = dom_call('__csimInnerHTML', handle).to_s
      def outer_html(handle)  = dom_call('__csimOuterHTML', handle).to_s
      def file_input?(handle)
        tag(handle) == 'input' && attr(handle, 'type').to_s.downcase == 'file'
      end
      def visible?(handle)    = dom_call('__csimVisible', handle) ? true : false

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
            partial = dom_call('__csimClickResolve', handle, init)
            sleep delay
            dom_call('__csimClickFinish', handle, partial.is_a?(Hash) ? partial['base'] : init)
          else
            dom_call('__csimClickResolve', handle, init)
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
            # round drains nothing rather than burning the full 8 engine
            # round-trips. Profile (Avo actions_spec / V8): the
            # unconditional loop cost ~7.7 % of wall time.
            8.times do
              @runtime.drain_microtasks
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
          consume_pending_frame_nav
          return
        end
        case action['kind']
        when 'navigate'
          url = action['url'].to_s
          target = action['target'].to_s
          # Inside a frame, a frame-targeted link (self, or `_parent` of a
          # ≥2-deep frame) navigates that FRAME, not the top page: fetch +
          # rebuild its realm. A self-targeted pure-fragment link is already
          # handled in-realm by the frame's own location JS, so skip it.
          if (frame_entry = frame_nav_target_entry(target))
            unless frame_entry.equal?(@frame_stack.last) && pure_fragment_navigation?(url)
              tick_real_time
              navigate_frame(resolve_against_current(url, use_base: true), entry: frame_entry)
            end
          # `target="_blank"` (or any non-_self/_top/_parent name) opens
          # in a new browsing context (its own Browser/VM); the primary
          # stays put (per HTML spec — original window is unaffected). A
          # `target=_blank` link defaults to `noopener` (window.opener null) unless
          # `rel=opener` (carried as `action['opener']`); open_aux_window forces
          # noopener anyway for a cross-partition blob. Matches the scripted
          # click / dispatchEvent activation paths.
          elsif !target.empty? && !%w[_self _top _parent].include?(target.downcase) && @driver.respond_to?(:open_aux_window)
            @driver.open_aux_window(resolve_against_current(url, use_base: true), source: self, opener: !!action['opener'], blob_snapshot: action['blob'])
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
              @runtime.drain_microtasks
              break if @runtime.drain_timers(50).to_i.zero?
            end
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
            submit_form_handle(action['formHandle'], action['submitter'], action['entryList'])
          end
        when 'download'
          download_link(resolve_against_current(action['url'].to_s), action['filename'].to_s)
        end
      end

      def download_link(url, filename_hint = '')
        env = Rack::MockRequest.env_for(url, method: 'GET')
        env['HTTP_USER_AGENT'] = @default_user_agent || USER_AGENT
        env['REMOTE_ADDR']     = self.class.remote_addr_for(env['HTTP_HOST'] || env['SERVER_NAME'])
        ck = cookie_header_for(env_cookie_host(env))
        env['HTTP_COOKIE']     = ck              unless ck.empty?
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
        doc_url = current_browsing_context_url
        return false if doc_url.nil?
        target = resolve_against_current(url)
        a = URI.parse(target)
        b = URI.parse(doc_url)
        # Same-document iff everything but the fragment matches AND the
        # fragment actually changes — `a.fragment != b.fragment` covers
        # both adding/changing a fragment and *clearing* one (target has
        # no fragment while the current URL does, e.g. `location.hash =
        # ''`). The old `!a.fragment.nil?` missed the clearing case, so a
        # hash-reset turned into a full document reload.
        a.scheme == b.scheme && a.host == b.host && a.port == b.port &&
          a.path == b.path && a.query == b.query && a.fragment != b.fragment
      rescue URI::InvalidURIError
        false
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
        @runtime.call('__csimUpdateLocation', new_url) if @runtime.respond_to?(:call)
      end

      def set_value_with_events(handle, value)
        mark_action_baseline
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        # `attach_file` hands us a Pathname (or Array of Pathnames);
        # the marshaller rejects non-primitive types. Coerce to a path-list
        # form V8 can hold — the actual multipart upload happens later
        # in `encode_entry_list` during form submission.
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
          dom_call('__csimSetFiles', handle, file_infos)
          # Mirror real browser: <input type=file>.value reflects only
          # the filename of the first chosen file (security-faked path).
          # __csimSetValue dispatches input + change synchronously.
          js_value = paths.first ? File.basename(paths.first) : ''
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
        (@file_picks && @file_picks[handle]) || []
      end

      # JS-side `__HostBackedFile.text()` / `arrayBuffer()` route through
      # this to read attached file bytes on demand — ActiveStorage's
      # `DirectUpload` MD5-chunks the file via FileReader before
      # POSTing to `/rails/active_storage/direct_uploads`. Returns
      # the requested byte range as base64 so binary content
      # survives the engine string boundary (same approach as
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
        mark_action_baseline
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        init = {'bubbles' => true, 'cancelable' => true, 'button' => 2, 'which' => 3}.merge(click_event_init(handle, keys, opts))
        dom_call('__csimDispatchEvent', handle, 'mousedown', init)
        sleep opts[:delay].to_f if opts[:delay].to_f > 0
        dom_call('__csimDispatchEvent', handle, 'mouseup',     init)
        dom_call('__csimDispatchEvent', handle, 'contextmenu', init)
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
        dom_call('__csimDropOnto', handle, items)
      end

      # Element-to-element drag. Capybara's `Element#drag_to(target,
      # delay: …)` lands here. Fires the HTML5 drag event sequence on
      # the source / target pair (mousedown → dragstart → dragenter →
      # dragover → drop → dragend) with a shared DataTransfer. Discourse
      # sidebar reorder + Avo Sortable-shaped widgets read the
      # `event.offsetY` to decide "above vs below"; without a layout
      # engine we report 0, which routes drops above the target.
      def drag_to(source_handle, target_handle, **_opts)
        mark_action_baseline
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(source_handle)
        ensure_alive_after_tick(target_handle)
        dom_call('__csimDragOnto', source_handle, target_handle)
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
        mark_action_baseline
        tick_real_time
        invalidate_find_cache
        ensure_alive_after_tick(handle)
        # UI Events spec: two full mousedown→mouseup→click chains
        # before the trailing `dblclick`. Jspreadsheet (table-builder's
        # `.jss_worksheet`) enters edit mode on the inner mousedown.
        2.times { dom_call('__csimClickResolve', handle, opts) }
        init = {'bubbles' => true, 'cancelable' => true}.merge(click_event_init(handle, keys, opts))
        dom_call('__csimDispatchEvent', handle, 'dblclick', init)
        # Real browsers' default-action on dblclick selects the word
        # under the cursor — ProseMirror / Tiptap "paste URL over
        # selection wraps with link" tests rely on the word being
        # selected before the paste.
        dom_call('__csimSelectWordAt', handle)
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
          rect = dom_call('__csimElementRect', handle)
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
        # side AND fires `mouseover` / `mouseenter` — keeping the
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
      # select_option). Without this hop the intent sits on the slot
      # forever and the form never actually navigates / POSTs.
      def consume_pending_form_submit
        pending = @runtime.call('__csimTakePendingFormSubmit')
        return unless pending.is_a?(Hash) && pending['formHandle']
        submit_form_handle(pending['formHandle'].to_i, pending['submitterHandle'], pending['entryList'])
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
        worker_wait_deadline = nil
        SETTLE_MAX_ITER.times do
          deliver_event_source_events
          deliver_worker_messages
          deliver_hijacked_fetches
          deliver_window_messages
          deliver_websocket_events
          break if @runtime.settle_gen > start_gen
          break unless @timers_active || event_source_pending? || worker_pending? || hijack_fetch_pending? || window_message_pending? || websocket_pending?
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
          break if @runtime.settle_gen == prev_gen && !@runtime.has_ready_timer? && !event_source_pending? && !worker_pending? && !hijack_fetch_pending? && !window_message_pending? && !websocket_pending?
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
          # `opener` reflects rel=opener (a bare target=_blank link is noopener);
          # open_aux_window forces noopener anyway for a cross-partition blob.
          @driver.open_aux_window(resolve_against_current(url, use_base: true), source: self, opener: !!pending['opener'], blob_snapshot: pending['blob'])
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
        form_handle = dom_call('__csimAncestorForm', handle).to_i
        return if form_handle.zero?
        submit_form_handle(form_handle, nil)
      end

      def title
        tick_real_time
        @runtime.call('__csimDocumentTitle').to_s
      end

      # `page.html` inside a `within_frame` block returns the frame document's
      # source (Selenium parity), so route through the active realm.
      def html
        tick_real_time
        dom_call('__csimDocumentHtml').to_s
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
        @history_idx              = -1
        @pending_history_traverse = nil
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
          # Pure pushState traversal — no VM rebuild, safe to run
          # inline; the popstate dispatch happens within the current
          # call's JS context.
          @history_idx = target
          entry = @history[target]
          @current_url = entry[:url]
          @runtime.call('__csimUpdateLocation', @current_url)
          @runtime.call('__csimDispatchPopState', entry[:state])
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
        capture_outgoing_form_state
        @history_idx = target
        replay_history_entry(@history[target])
        restore_form_state(@history[target])
      end

      # Snapshot the OUTGOING document's form-control state into the history entry
      # we are leaving, so a later back/forward traversal to it restores the
      # values the user/script had set (HTML "persisted user state"), not the
      # markup defaults. Captured while the outgoing VM is still live — before
      # record_history advances the index or boot rebuilds the context.
      def capture_outgoing_form_state
        return if @history_idx < 0 || (entry = @history[@history_idx]).nil?
        state = (@runtime.call('__csimCaptureFormState') rescue nil)
        entry[:form_state] = state if state
      end

      # Re-apply a history entry's captured form state after its document has been
      # rebuilt. The JS setters set the dirty value flag WITHOUT firing
      # input/change, so a restored value doesn't look like a fresh user edit.
      def restore_form_state(entry)
        return unless entry && (state = entry[:form_state])
        @runtime.call('__csimRestoreFormState', state) rescue nil
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
        # arrow navigation) commits before the next key fires. Tab /
        # backtab are focus-advance, dispatched out of band.
        held = []
        Array(keys).each do |k|
          sym = k.is_a?(Symbol) ? k : (k.respond_to?(:to_sym) ? k.to_sym : nil)
          if sym == :tab || sym == :backtab
            dom_call('__csimAdvanceFocus', sym == :backtab)
          elsif sym && MODIFIER_KEY_NAMES.include?(sym)
            held << sym
          else
            handle = active_element_handle
            handle = current_document_handle if handle.nil? || handle.zero?
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
        # Drain timers first so ready handlers (jQuery `$(handler)`,
        # framework `DOMContentLoaded` listeners) run before the
        # user's script. Without this, `execute_script` can fire
        # *before* the page's own setup code that the test expects
        # to be active.
        tick_real_time
        invalidate_find_cache
        # Routes to the active frame realm inside `within_frame` (Selenium
        # parity: `evaluate_script` runs in the current browsing context).
        result = dom_call('__csimEvalScript', code.to_s, marshal_args(args || []))
        drain_pending_navigation
        result
      end

      # Fire-and-forget variant: runs the script but never returns
      # its value to Ruby. Lets execute_script handle scripts whose
      # return is a complex JS object (jQuery chainable, DOM tree,
      # …) that the marshaller would recurse into.
      def execute_script(code, args = [])
        tick_real_time
        invalidate_find_cache
        dom_call('__csimExecScript', code.to_s, marshal_args(args || []))
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
        return true if worker_pending? || event_source_pending? || hijack_fetch_pending? || window_message_pending? || websocket_pending?
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
      # When `step_ms` is omitted, advance by `horizon_fast_forward_step` — a
      # DETERMINISTIC step (never wall-derived, so per-poll JS/Ruby/GC cost can't
      # shift when a timer fires): a fixed `POLL_TICK_STEP_MS` per poll, fast-
      # forwarding straight to a near-future timer when the page is otherwise idle.
      # Explicit `step_ms` is used by `SleepHook#advance_virtual_clock_ms` (from
      # `Kernel#sleep`) and by `Playwright::Page#wait_for_timeout` to step a
      # precise virtual duration.
      def tick_real_time(step_ms: nil)
        return unless @timers_active || worker_pending? || event_source_pending? || hijack_fetch_pending? || window_message_pending? || websocket_pending?
        # Re-entrancy guard. Capybara's `Result#each` triggers nested
        # finds (visible? per element); the outermost tick has already
        # advanced the clock, the inner calls would only re-drain
        # already-fired timers.
        return if @ticking
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
        loop do
          r = @runtime.run_loop_step(0)          # run only what's due NOW + microtasks + render; no clock advance
          progressed = step_and_drain_progressed(r)
          turns += 1
          break unless progressed
          break if turns >= EVENT_LOOP_QUIESCENCE_CAP
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

        # Phase 2 — advance one real frame so the next batch of timers becomes due.
        # Its work counts toward `progressed` too: a timer that first comes due in
        # this advance (e.g. a `setTimeout(…, 8)` firing mid-frame) and the nav hop
        # it queues are real progress, so a caller mustn't read the frame as idle.
        frame_progressed = step_and_drain_progressed(@runtime.run_loop_step(frame_ms))
        probe = dom_call('__csimEventLoopProbe')
        {
          'raf'        => !!probe['raf'],
          'async'      => !!probe['async'],
          # ms until the nearest scheduled timer (-1 = none). Lets a caller keep
          # advancing while a near-future `setTimeout` is parked (a `step_timeout`-
          # style wait) instead of declaring the page idle — see `__csimEventLoopProbe`.
          'next_timer' => probe['nextTimer'].to_f,
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
        drain_pending_navigation
        consume_pending_form_submit
        consume_pending_download
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
          !(@pending_frame_reload || []).empty?
      end

      # Pull every background async channel (Worker / EventSource / hijacked fetch
      # / postMessage / WebSocket) into JS state, marking the find cache dirty if
      # any delivered. Shared by `tick_real_time` and `run_event_loop_frame`.
      # Returns true if any channel delivered.
      private def drain_async_channels
        n = deliver_worker_messages + deliver_event_source_events + deliver_hijacked_fetches +
            deliver_window_messages + deliver_websocket_events
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
        if worker_pending? || event_source_pending? || hijack_fetch_pending? || websocket_pending?
          @ff_transient_polls = 0
          return POLL_TICK_STEP_MS
        end
        # No fast-forward support on this runtime (e.g. a worker realm) → fixed step.
        return POLL_TICK_STEP_MS unless @runtime_supports_ff
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
        @context_gen       += 1
      end

      attr_reader :context_gen

      # Pulls the serialised form-state out of JS, encodes it, and
      # drives the Rack app via `navigate` (for GET) or a POST. `entry_list` is the
      # list JS already constructed (post-`formdata`, so a handler's append/delete
      # is honoured); when absent (the Enter implicit-submit path) we build it from
      # the form's own controls.
      def submit_form_handle(form_handle, submitter_handle, entry_list = nil)
        invalidate_find_cache
        spec = dom_call('__csimFormSerialize', form_handle, submitter_handle || 0)
        return unless spec.is_a?(Hash)
        action  = spec['action'].to_s
        method  = spec['method'].to_s.upcase
        method  = 'GET' if method.empty?
        enctype = spec['enctype'].to_s.empty? ? 'application/x-www-form-urlencoded' : spec['enctype'].to_s.downcase
        entries = entry_list.is_a?(Array) ? entry_list : entries_from_spec(spec)
        action_url = action.empty? ? (current_browsing_context_url || @default_host) : resolve_against_current(action)
        # A form submitted inside a frame whose target is that frame (self, or a
        # `_parent` of a ≥2-deep frame) navigates the FRAME, not the top page.
        frame_entry = frame_nav_target_entry(spec['target'])
        # A non-frame named target (`_blank`, or a window name that isn't a frame)
        # submits into a NEW/named browsing context — open (or reuse) an aux window,
        # mirroring the link `target=_blank` branch. `_blank` is always a fresh window;
        # a named target that matches THIS window's own `window.name` navigates in
        # place (HTML named-context targeting), so it isn't a new window.
        target = spec['target'].to_s
        named_target = frame_entry.nil? && !target.empty? &&
                       !%w[_self _top _parent].include?(target.downcase) &&
                       @driver.respond_to?(:open_aux_window)
        own_name   = named_target ? (@runtime.call('__csimReadWindowProp', false, 'name').to_s rescue '') : ''
        new_window = named_target && (target.casecmp?('_blank') || target != own_name)
        window_name = target.casecmp?('_blank') ? '' : target
        # Opener exposure for a `<form target>` new context, per the link-relation
        # model: `noopener`/`noreferrer` always drop the opener; `target=_blank`
        # ALSO defaults to noopener unless `rel=opener` opts back in (a named target
        # keeps its opener by default). `noreferrer` additionally empties the referrer.
        rel_tokens  = spec['rel'].to_s.downcase.split(/\s+/)
        no_referrer = rel_tokens.include?('noreferrer')
        keep_opener = !no_referrer && !rel_tokens.include?('noopener') &&
                      (target.downcase != '_blank' || rel_tokens.include?('opener'))
        referrer    = no_referrer ? '' : (@current_url || '')
        # Opening a new top-level browsing context consumes transient user activation.
        @runtime.call('__csimConsumeTransientActivation') if new_window rescue nil
        if method == 'GET'
          # GET ignores enctype: the entry list is always the urlencoded query.
          query, = encode_entry_list(entries, 'application/x-www-form-urlencoded')
          uri = URI.parse(action_url)
          # HTML "mutate action URL" for GET: SET the query to the entry list
          # unconditionally — an empty list clears any query the action already
          # carried (browsers navigate to `action?`), it isn't preserved.
          uri.query = query
          if new_window
            @driver.open_aux_window(uri.to_s, name: window_name, source: self,
                                    opener: keep_opener, referrer: referrer)
          elsif frame_entry
            navigate_frame(uri.to_s, entry: frame_entry)
          else
            navigate(uri.to_s)
          end
        else
          body, content_type = encode_entry_list(entries, enctype)
          if new_window
            @driver.open_aux_window(action_url, name: window_name, source: self,
                                    opener: keep_opener, referrer: referrer,
                                    post: {body: body, content_type: content_type})
          elsif frame_entry
            navigate_frame_post(action_url, body, content_type, entry: frame_entry)
          else
            navigate_post(action_url, body, content_type)
          end
        end
      end

      # HTML "encode the entry list" by enctype → [body, exact Content-Type]. The
      # Content-Type is sent verbatim (no charset suffix), which the spec's
      # form-submission resources compare exactly. text/plain is `name=value\r\n`
      # per entry (NOT urlencoded); urlencoded (and GET) merge each file entry as
      # its bare filename. `entries` is the ordered entry list — string
      # {'name','value'} or file {'name','file'=>true,'filename','handle','index'}
      # entries; a file's bytes resolve through the `@file_picks` slot.
      def encode_entry_list(entries, enctype)
        if enctype.start_with?('multipart/form-data')
          boundary = "csim-#{SecureRandom.hex(8)}"
          body     = String.new.force_encoding(Encoding::ASCII_8BIT)
          entries.each do |e|
            if e['file']
              path = entry_file_path(e)
              if path
                append_multipart_part(body, boundary, e['name'].to_s, File.binread(path),
                                      filename:     File.basename(path),
                                      content_type: Rack::Mime.mime_type(File.extname(path)))
              elsif e['b64']
                # An in-memory `new File([…])` has no on-disk slot; its bytes are
                # carried base64-encoded from the VM. Decode them for the part body.
                content = e['b64'].to_s.unpack1('m')
                ct      = e['type'].to_s
                ct      = 'application/octet-stream' if ct.empty?
                append_multipart_part(body, boundary, e['name'].to_s, content,
                                      filename: e['filename'].to_s, content_type: ct)
              else
                append_multipart_part(body, boundary, e['name'].to_s, '', filename: e['filename'].to_s)
              end
            else
              append_multipart_part(body, boundary, e['name'].to_s, e['value'].to_s)
            end
          end
          body << "--#{boundary}--\r\n"
          [body, "multipart/form-data; boundary=#{boundary}"]
        else
          # The urlencoded / text-plain encoders normalize CR/LF → CRLF in each entry's
          # name and value (a file entry's filename is the value) — the entry list itself
          # stays raw, so normalization lives here, matching the JS encoders and real
          # browsers (newline-normalization.html).
          pairs = entries.map {|e|
            [normalize_form_newlines(e['name']), normalize_form_newlines(e['file'] ? e['filename'] : e['value'])]
          }
          if enctype == 'text/plain'
            [pairs.map {|name, value| "#{name}=#{value}\r\n" }.join, 'text/plain']
          else
            [URI.encode_www_form(pairs), 'application/x-www-form-urlencoded']
          end
        end
      end

      # HTML form-submission newline normalization: every lone CR, lone LF, and CRLF in an
      # entry name/value becomes a CRLF (the JS encoders' `normalizeNL` counterpart).
      def normalize_form_newlines(s)
        s.to_s.gsub(/\r\n?|\n/, "\r\n")
      end

      # Resolve a threaded file entry's on-disk path via the `@file_picks` slot
      # recorded at `attach_file` time (handle/index). nil for a purely in-memory
      # `new File(['bytes'], …)` (no slot) — a CLASSIC (non-Turbo) submit then
      # drops its bytes, while the fetch/XHR path serializes them in JS
      # (`serializeMultipart` → `blobBytes`). This covers every realistic upload
      # (a host-backed file submitted through Turbo or a plain form).
      def entry_file_path(entry)
        handle = entry['handle']
        return nil if handle.nil?
        picks = @file_picks && @file_picks[handle.to_i]
        picks && picks[entry['index'].to_i]
      end

      # Build the entry list from the form's own controls, for triggers that didn't
      # construct one in JS (the Enter implicit-submit path). Mirrors the JS FormData
      # construction: non-file fields in tree order, then each file input's selection
      # (one empty entry when nothing is picked). A selected File reports its
      # host-backed source (`handle`/`index`); the older payload shape with no per-File
      # refs falls back to the input's own handle slot.
      def entries_from_spec(spec)
        entries = (spec['fields'] || []).map {|pair| {'name' => pair[0].to_s, 'value' => pair[1].to_s} }
        (spec['fileInputs'] || []).each do |fi|
          name = fi['name'].to_s
          refs = fi['files']
          if refs.is_a?(Array) && !refs.empty?
            refs.each {|ref|
              entries << {'name' => name, 'file' => true, 'filename' => ref['name'].to_s, 'handle' => ref['handle'], 'index' => ref['index']}
            }
          else
            picks = (@file_picks && @file_picks[fi['handle'].to_i]) || []
            if picks.empty?
              entries << {'name' => name, 'file' => true, 'filename' => '', 'handle' => nil, 'index' => nil}
            else
              picks.each_index {|i|
                entries << {'name' => name, 'file' => true, 'filename' => File.basename(picks[i]), 'handle' => fi['handle'], 'index' => i}
              }
            end
          end
        end
        entries
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

      def navigate_post(url, body, content_type, depth: 0, from_history: false, referer: @current_url)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
        unless from_history || depth > 0
          capture_outgoing_form_state
          record_history({method: :post, url: url, body: body, content_type: content_type})
        end
        env = Rack::MockRequest.env_for(url, method: 'POST', input: body)
        env['CONTENT_TYPE']   = content_type.empty? ? 'application/x-www-form-urlencoded' : content_type
        env['CONTENT_LENGTH'] = body.bytesize.to_s
        apply_default_request_env(env, referer: referer)
        status, headers, resp_body = dispatch_rack_or_http(url, env, method: 'POST', body: body)
        merge_set_cookie(headers, url)
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
        @cache_storage.clear
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
        # A test may leave a frame switched-to without switching back
        # (Capybara's reset_session spec covers exactly this); start the
        # next test back on the main document.
        reset_frame_scope
        @history.clear
        @history_idx     = -1
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
        # Free any zero-copy transfer backing stores that went unimported
        # (worker killed before draining its inbox, etc.) before the rebuild.
        drop_pending_transfers
        @blob_registry_lock.synchronize { @blob_registry.clear; @blob_owners.clear }
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

      # Tear down an auxiliary window's Browser when its window closes (the
      # Driver calls this on close_window / reset!). Releases what a bare GC of
      # the isolate would NOT: live background threads (worker / SSE / hijacked-
      # fetch / WebSocket readers) and any parked zero-copy transfer backing
      # stores this window issued (the transfer registry is process-wide). Runs
      # while the runtime is still alive so the transferDrop call lands.
      def dispose
        drop_pending_transfers
        reset_workers
        reset_event_sources
        reset_hijacked_fetches
        reset_websockets
        @window_inbox.clear
        @broadcast_inbox.clear
        # Dispose the JS runtime/isolate itself — for an auxiliary window this
        # Browser is the isolate's last owner, but V8Runtime registers every
        # isolate in a process-wide `@@live` set (for at_exit cleanup), which
        # pins it past a bare GC. Without this, each closed window leaked a live
        # V8 isolate (RSS climbed across a long suite). Only reached on teardown,
        # never on the per-test `reset!` path (which keeps the runtime).
        @runtime.dispose if @runtime.respond_to?(:dispose)
      rescue StandardError
        nil
      end

      # ── Host-fn callbacks invoked by bridge.js ──────────────────

      def rack_fetch_body(url)
        result = rack_fetch('GET', url, '', {}, 'follow')
        return nil unless result && result['status'].to_i < 400
        result['body'].to_s
      end

      # Fetch a source body and report how long it stays safely reusable per its
      # OWN response headers — an absolute freshness deadline (Time), or nil when
      # the response is not durably cacheable (no-store / no-cache / max-age=0 /
      # dynamic with no freshness). This lets a loader persist the body across
      # visits and skip the round-trip next time, driven by the server's cache
      # directives (RFC 9111 §5.2.2 / §4.2.2 heuristic) — NOT a URL-shape guess.
      # `clear_volatile` drops the body from the volatile per-visit asset cache,
      # but a content-hashed asset's source is content-stable while fresh, so a
      # loader's own cross-visit cache can hold it for `fresh_until`. Used by
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
      # fresh VM per visit (`reset_page` → `clear_volatile`) would otherwise
      # re-fetch the same fingerprinted app assets (avo.base.js, avo.base.css, …)
      # on every visit — a real browser HTTP-caches them once. Safety: only
      # responses the server marks durably cacheable (`fresh_until` from max-age)
      # are stored, and these are content-stable assets at content-hashed URLs
      # (a change yields a new URL = cache miss), so a stale body can't shadow a
      # later test. Survives `clear_volatile` (that is the point); size-capped.
      @@asset_src      = {}
      @@asset_src_lock = Mutex.new
      ASSET_SRC_MAX    = 4096

      # Decoded-image cache: resolved-URL => {'width'=>, 'height'=>, 'bytes'=> packed
      # RGBA String}. Decoding an image (libvips) is the expensive step, so — like the
      # V8 bytecode cache and the script/stylesheet source cache above — we keep the
      # decoded pixels and reuse them for every `<img>` sharing a src, across elements
      # AND visits. Same content-stability assumption as `@@asset_src` (a URL's bytes
      # are stable within a process; content-hashed / data: URLs that dominate satisfy
      # it); size-capped so an app cycling through many distinct images can't grow it
      # without bound.
      @@image_cache      = {}
      @@image_cache_lock = Mutex.new
      IMAGE_CACHE_MAX    = 512

      # Cross-visit cache of @font-face font files, resolved-url → on-disk path (or nil
      # when the fetch failed). The bytes are written to a process-lifetime temp file so
      # pango/fontconfig (via `Vips::Image.text fontfile:`) can read them by path. Font
      # URLs are content-stable app assets, so caching across the per-visit VM rebuild
      # avoids re-fetching CanvasTest.ttf & friends on every visit.
      @@font_file_cache      = {}
      @@font_file_lock       = Mutex.new
      @@font_files           = []   # pins the Tempfiles for the PROCESS (the cache is cross-visit)

      # Body of an external durably-cacheable asset (classic script or stylesheet),
      # served from the cross-visit cache when still fresh, else fetched (which
      # read-throughs the per-visit asset cache) and cached iff durably cacheable.
      # Returns nil on 4xx / fetch failure so the JS caller skips it exactly as the
      # old `__rackFetch` branch did.
      def external_asset_source(url)
        # A blob:/data:/about: document's location can't anchor an absolute-path
        # `src=/common/…` (URI.join on a `blob:` URL yields nothing usable), but its
        # `<base href>` points at a real http(s) origin — so for THOSE documents
        # resolve against `<base href>` (HTML base-tag semantics) and the script loads.
        # Ordinary http(s) pages keep the document-URL base so the hot path skips the
        # `base_href` dom_call (CLAUDE.md rule 3).
        needs_base = @current_url.to_s.start_with?('blob:', 'data:', 'about:')
        key = resolve_against_current(url.to_s, use_base: needs_base)
        return nil unless key.is_a?(String)
        @@asset_src_lock.synchronize do
          if (e = @@asset_src[key])
            return e[0] if e[1].nil? || Time.now < e[1]
            @@asset_src.delete(key)
          end
        end
        # `durable_source` already does the spec-compliant fetch + header-driven
        # freshness (RFC 9111 max-age → absolute deadline); reuse it instead of
        # re-deriving `fresh_until` here.
        body, fresh_until = durable_source(key)
        return nil unless body
        # Script / stylesheet source is TEXT, but the raw Rack / binread body
        # arrives BINARY-tagged (see `RuntimeShared.utf8_text`).
        body = RuntimeShared.utf8_text(body)
        if fresh_until
          @@asset_src_lock.synchronize do
            @@asset_src.clear if @@asset_src.size >= ASSET_SRC_MAX
            @@asset_src[key] = [body, fresh_until]
          end
        end
        body
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
      # rusty_racer / quickjs.rb VMs are single-threaded; only the main
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
        # Forward the streaming host's cookie jar so the server can
        # authenticate the user the same way the browser would — scoped to
        # the EventSource target's host, like every other request.
        cookies = cookie_header_for(cookie_host(uri))
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
        # SSE is a UTF-8 TEXT protocol (the spec decodes the stream as UTF-8),
        # but these strings are slices of the BINARY socket buffer (see
        # `RuntimeShared.utf8_text`).
        {
          type:        RuntimeShared.utf8_text(type || 'message'),
          data:        RuntimeShared.utf8_text(data.join("\n")),
          lastEventId: last_id && RuntimeShared.utf8_text(last_id)
        }
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

      def ws_open(url, protocols = nil)
        id       = (@websocket_seq += 1)
        # ws:// → http://, wss:// → https:// for the Rack env; resolve relative
        # against the current document (Action Cable's consumer builds an
        # absolute ws URL, but be tolerant).
        http_url = url.to_s.sub(/\Awss/i, 'https').sub(/\Aws/i, 'http')
        target   = resolve_against_current(http_url)
        key      = SecureRandom.base64(16)
        csim_io, app_io = Socket.pair(:UNIX, :STREAM, 0)
        env = Rack::MockRequest.env_for(target, method: 'GET')
        apply_default_request_env(env, referer: @current_url)
        env['HTTP_UPGRADE']               = 'websocket'
        env['HTTP_CONNECTION']            = 'Upgrade'
        env['HTTP_SEC_WEBSOCKET_KEY']     = key
        env['HTTP_SEC_WEBSOCKET_VERSION'] = '13'
        list = Array(protocols).map(&:to_s).reject(&:empty?)
        env['HTTP_SEC_WEBSOCKET_PROTOCOL'] = list.join(', ') unless list.empty?
        env['rack.hijack?']  = true
        env['rack.hijack']   = -> { app_io }
        env['rack.hijack_io'] = app_io
        # The app hijacks + writes the 101 (synchronously, or on its own event
        # loop thread — Action Cable handles the upgrade on a separate thread, so
        # `@app.call` may return before the handshake bytes appear; the reader
        # blocks until they do). Run it on the main thread like the long-poll
        # hijack so we don't race a second concurrent `@app.call`. (No handshake
        # timeout: a server that never writes the 101 leaks the reader+socket
        # until `reset_websockets` — acceptable, real servers always respond.)
        @app.call(env)
        @websocket_sockets[id]     = csim_io
        @websocket_app_sockets[id] = app_io
        accept = Digest::SHA1.base64digest(key + WS_GUID)
        queue  = @websocket_queue
        @websocket_threads[id] = Thread.new do
          Thread.current.report_on_exception = false
          run_websocket_reader(id, csim_io, accept, queue)
        end
        id
      rescue StandardError => e
        # Nothing was registered for cleanup yet — close both pair ends here so
        # a failed upgrade (mis-routed URL, app error) doesn't leak fds.
        csim_io.close rescue nil
        app_io.close  rescue nil
        @websocket_queue << {id: id, type: '__error', message: "#{e.class}: #{e.message}"}
        id
      end

      # `binary` is set by the JS side (it knows whether `send` was given a
      # string or an ArrayBuffer/view) → opcode 0x2 vs the text 0x1. Action
      # Cable is text-only (JSON). `b64` is set when the bytes arrived base64-
      # encoded (the QuickJS binary path — raw bytes ≥0x80 don't survive its
      # host boundary); decode before framing.
      def ws_send(id, data, binary = false, b64 = false)
        sock = @websocket_sockets[id.to_i] or return
        if binary
          ws_write_frame(sock, 0x2, b64 ? Base64.decode64(data.to_s) : data.to_s.b)
        else
          ws_write_frame(sock, 0x1, data.to_s.b)
        end
        nil
      rescue StandardError
        nil
      end

      def ws_close(id, code = 1000, reason = '')
        sock = @websocket_sockets[id.to_i] or return
        # Send the close frame and let the close HANDSHAKE complete: the server
        # replies with its own close frame, which the reader thread surfaces as
        # the `__close` event (carrying the agreed code) before tearing the
        # socket down in its `ensure`. Force teardown is `reset_websockets`'s job.
        payload = [code.to_i].pack('n') + reason.to_s.b
        ws_write_frame(sock, 0x8, payload) rescue nil
        nil
      end

      def websocket_pending? = !@websocket_queue.empty?

      def deliver_websocket_events
        return 0 if @websocket_threads.empty? && @websocket_queue.empty?
        events = drain_queue(@websocket_queue)
        return 0 if events.empty?
        @runtime.call('__csim_deliverWebSocketEvents', events)
        events.size
      end

      def reset_websockets
        @websocket_threads.each_value(&:kill)
        @websocket_threads.clear
        # Close BOTH pair ends: csim's read/write end and the app's hijack end
        # (the app may abandon its end without closing it — e.g. its connection
        # thread was just killed), so neither leaks across tests.
        @websocket_sockets.each_value     {|s| s.close rescue nil }
        @websocket_app_sockets.each_value {|s| s.close rescue nil }
        @websocket_sockets.clear
        @websocket_app_sockets.clear
        @websocket_queue.clear
      end

      # Background-thread frame reader: verify the 101 handshake, then loop
      # decoding server→client frames into queue events until close / EOF.
      private def run_websocket_reader(id, sock, expected_accept, queue)
        ok, protocol = ws_read_handshake(sock, expected_accept)
        unless ok
          queue << {id: id, type: '__error', message: 'websocket handshake failed'}
          return
        end
        # Carry the negotiated subprotocol — Action Cable's client closes the
        # connection in its `onopen` unless `webSocket.protocol` is one it knows
        # (`actioncable-v1-json`).
        queue << {id: id, type: '__open', protocol: protocol}
        loop do
          frame = ws_read_message(sock, queue, id)
          break if frame.nil?                       # EOF
          opcode, payload = frame
          if opcode == :close
            code   = payload.bytesize >= 2 ? payload[0, 2].unpack1('n') : 1005
            reason = payload.bytesize > 2 ? RuntimeShared.utf8_text(payload[2..]) : ''
            queue << {id: id, type: '__close', code: code, reason: reason}
            break
          end
          # Binary frames cross to JS as raw bytes (wrap_binary) tagged so the
          # JS side decodes them per `binaryType`; text is UTF-8.
          if opcode == 0x2
            queue << {id: id, type: 'message', binary: true, data: @runtime.wrap_binary(payload)}
          else
            queue << {id: id, type: 'message', data: RuntimeShared.utf8_text(payload)}
          end
        end
      rescue StandardError => e
        queue << {id: id, type: '__close', code: 1006, reason: e.message.to_s[0, 120]}
      ensure
        # Only the socket (a local) is closed here — the `@websocket_*` hashes
        # are mutated solely on the main thread (`reset_websockets`) to avoid a
        # cross-thread Hash race; a closed entry just no-ops on the next access.
        sock.close rescue nil
      end

      # Read + validate the 101 Switching Protocols response (status line +
      # headers up to the blank line). Returns `[accept_ok, negotiated_protocol]`
      # — the accept hash must match the handshake key, and the negotiated
      # `Sec-WebSocket-Protocol` (nil if none) is surfaced so `webSocket.protocol`
      # is set (Action Cable's client requires `actioncable-v1-json`).
      private def ws_read_handshake(sock, expected_accept)
        status = sock.gets
        return [false, nil] unless status && status =~ %r{\AHTTP/1\.1 101}i
        accept_ok = false
        protocol  = nil
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
        end
        [accept_ok, protocol]
      end

      # Read one complete message (reassembling continuation frames), handling
      # interleaved control frames inline. Returns `[opcode, payload]` (opcode
      # 0x1 text / 0x2 binary, or `:close`), or nil on EOF.
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
          else          msg_opcode = opcode; data << payload       # 0x1 text / 0x2 binary
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
            # Slices of the BINARY socket buffer (see `RuntimeShared.utf8_text`).
            headers[RuntimeShared.utf8_text(k)] = RuntimeShared.utf8_text(v)
          end
        end
        # The held-poll body is TEXT (long-poll JSON); the socket read is
        # BINARY-tagged.
        body = RuntimeShared.utf8_text(body.to_s)
        {'status' => status, 'headers' => headers, 'body' => body}
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
      def worker_spawn(url, shared: false, service: false, creator_key: nil)
        handle       = (@worker_seq += 1)
        target       = resolve_against_current(url.to_s)
        # A worker script from a blob: URL in a DIFFERENT storage partition than this
        # context can't be created (cross-partition-worker-creation): the worker would
        # run in the creating context's partition, not the blob's. Deliver an error so
        # Worker/SharedWorker fires `onerror`, and spawn no thread. The handle is still
        # >0 so the JS registers the worker and the queued __error reaches it.
        if target.start_with?('blob:') && @driver.respond_to?(:cross_partition_blob?) && @driver.cross_partition_blob?(target, self)
          return worker_fail(handle, 'Worker creation from a cross-partition blob URL is blocked')
        end
        inbox        = Thread::Queue.new
        outbox       = @worker_outbox
        engine_class = @runtime.class
        # Resolve the worker script body on the main thread before
        # handing off to the worker. `blob:` URLs need the main VM's
        # blob registry; calling into the main runtime from a
        # non-owning thread SEGVs (V8 isolates are thread-
        # bound; quickjs.rb's VM is similarly per-thread).
        body = fetch_worker_script(target)
        # A blob: worker script that didn't resolve (revoked / unavailable) fails the
        # same way — fire onerror rather than spawn a worker that runs nothing.
        return worker_fail(handle, 'Worker script could not be loaded') if target.start_with?('blob:') && body.to_s.empty?
        # Pending until the worker's initial script has run (see @worker_initializing).
        @worker_init_lock.synchronize { @worker_initializing += 1 }
        thread = Thread.new do
          Thread.current.report_on_exception = false
          run_worker(handle, target, body, inbox, outbox, engine_class, shared: shared, service: service, creator_key: creator_key)
        end
        @workers[handle] = {thread: thread, inbox: inbox}
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
        return unless w
        @worker_in_flight += 1
        w[:inbox] << data.to_s
      end

      # `ServiceWorker.postMessage` from a client window → deliver to the SW's `message` event with
      # `source` = the posting client. Tracked in @sw_message_pending (released by the worker's
      # `swack`) so settle waits for the SW to process it and any client.postMessage reply.
      def service_worker_post_message(handle, data, client_id = nil, client_url = nil)
        w = @workers[handle.to_i]
        return unless w
        @sw_message_pending += 1
        w[:inbox] << {kind: 'sw_message', data: data.to_s, client: client_id, url: client_url}
      end

      # A controlled client's fetch → the controlling SW's `fetch` event. Tracked in
      # @sw_fetch_pending (released by the `fetch_response`) so settle waits for the SW's
      # respondWith. If the handle is dead, return false so the client falls back to the network.
      def service_worker_controller_fetch(handle, req_json, fetch_id, realm_id = 0)
        w = @workers[handle.to_i]
        return false unless w
        # Resolve BEFORE bumping the pending counter: a raise here must not strand @sw_fetch_pending
        # (settle would then block for the full round-trip budget with no fetch ever queued to answer).
        req = resolve_sw_fetch_referrer(req_json.to_s)
        @sw_fetch_pending += 1
        # fetch ids are per-realm (so they collide across realms) — carry the ORIGINATING realm so
        # the response is delivered back to it, not the main realm (realm 0 = main/top window).
        w[:inbox] << {kind: 'fetch', req:, fetch_id: fetch_id.to_i, realm_id: realm_id.to_i}
        true
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
      private def sw_deliver_fetch_response(handle, fetch_id, resp, outbox, realm_id = 0)
        if fetch_id.negative?
          @sw_nav_outbox << {fetch_id: fetch_id, resp: resp}
        else
          outbox << {handle: handle, kind: 'fetch_response', fetch_id: fetch_id, resp: resp, realm_id: realm_id}
        end
      end

      # Mirror a registration's active-worker handle into Ruby, keyed by its (serialized) scope.
      # Emitted by the client lifecycle at activation; survives rebuild_ctx so a navigation can
      # find its controlling SW even after the destination realm's JS was rebuilt.
      def sw_register_scope(scope, handle)
        @sw_registrations[scope.to_s] = handle.to_i
        # Flush any clients.claim() that arrived before this scope was mirrored (a worker's
        # `activate → clients.claim()` fires decoupled from the client-side lifecycle that populates
        # @sw_registrations, so the claim can be drained first — see the claim handler above).
        if @sw_pending_claims.any? {|e| e[:handle].to_i == handle.to_i }
          flush, @sw_pending_claims = @sw_pending_claims.partition {|e| e[:handle].to_i == handle.to_i }
          flush.each {|e| broadcast_claim(e[:handle], e[:has_fetch], scope.to_s) }
        end
        nil
      end

      # Deliver a clients.claim() to EVERY in-scope client: broadcast to the main realm AND every
      # frame realm; each self-checks whether its own document is in the claiming registration's
      # scope (__csim_swClaimClient) so no realm→URL map is needed here. has_fetch = the SW's
      # install-time fetch-listener snapshot, so a claimed client routes its fetches.
      private def broadcast_claim(handle, has_fetch, scope)
        script_url = @workers.dig(handle.to_i, :script_url).to_s
        # The authoritative registration scope set — the claim's longest-registration-wins check runs
        # against this, not a realm-local map that can lag under load (claim-not-using-registration).
        all_scopes = @sw_registrations.keys
        @runtime.call('__csim_swClaimClient', handle, has_fetch, script_url, scope, all_scopes)
        @runtime.frame_realm_ids.each do |rid|
          @runtime.realm_call(rid, '__csim_swClaimClient', handle, has_fetch, script_url, scope, all_scopes) if @runtime.frame_realm_alive?(rid)
        end
        nil
      end
      def sw_unregister_scope(scope)
        @sw_registrations.delete(scope.to_s)
        nil
      end

      # The registration handle controlling `url` — the one whose serialized scope is the longest
      # prefix of `url` (spec "Match Service Worker Registration"; the scope embeds the origin, so
      # a cross-origin scope can't prefix-match). nil when no registration's scope matches.
      private def sw_scope_match(url)
        u = url.to_s
        best = nil
        best_len = -1
        @sw_registrations.each do |scope, handle|
          next unless u.start_with?(scope) && scope.length > best_len
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
      def sw_client_controller_for(url)
        match = sw_scope_match(url) or return nil
        handle, scope = match
        w = @workers[handle] or return nil
        return nil unless w[:thread]&.alive?

        [handle, w[:has_fetch] != false, w[:script_url].to_s, scope]
      end

      # The controller an OPAQUE child browsing context (about:blank / srcdoc)
      # inherits from its creator. An about:blank document has no URL to scope-match,
      # so it's controlled by its parent's active service worker (HTML "create and
      # initialize a Document" inherits the creator's controller). Keyed by the
      # parent frame realm's id, recorded when that realm was wired (below).
      def sw_inherited_controller_for(parent_realm_id)
        return nil if parent_realm_id.nil? || parent_realm_id.to_i.zero?
        ctrl = @sw_realm_controller[parent_realm_id.to_i]
        return nil unless ctrl && @workers[ctrl[0]]&.dig(:thread)&.alive?

        ctrl
      end

      # Remember a frame/window realm's controller so its OWN opaque children can
      # inherit it (sw_inherited_controller_for). Set at frame-realm build for both
      # a scope-matched and an inherited controller, so inheritance chains through
      # nested about:blank frames.
      def sw_note_realm_controller(realm_id, ctrl)
        @sw_realm_controller[realm_id.to_i] = ctrl
        nil
      end

      # Register a controlled client (a frame/window realm) with its controlling SW
      # so `clients.matchAll()` / `getClientByURL` reflect the real client set — not
      # only clients that happened to postMessage the worker. The client id is
      # realm-scoped (`client-<realm>`), stable for the realm's life. Pushed to the
      # SW inbox (processed FIFO, so it precedes any later message that matchAll's it).
      def sw_register_client(realm_id, url, type, frame_type, handle)
        w = @workers[handle.to_i] or return
        rec = {'id' => "client-#{realm_id.to_i}", 'url' => url.to_s, 'type' => type.to_s, 'frameType' => frame_type.to_s}
        @sw_clients[realm_id.to_i] = {handle: handle.to_i, rec: rec}
        w[:inbox] << {kind: 'client_register', client: rec}
        nil
      end

      # Drop a client whose realm was disposed (frame navigated away / removed) so
      # matchAll stops returning a dead client. No-op for an unregistered realm.
      def sw_unregister_client(realm_id)
        @sw_realm_controller.delete(realm_id.to_i)
        entry = @sw_clients.delete(realm_id.to_i) or return
        w = @workers[entry[:handle]] or return
        w[:inbox] << {kind: 'client_unregister', id: entry[:rec]['id']}
        nil
      end

      # ── Cross-isolate MessagePort channel relay (client realm ↔ worker/SW isolate) ──
      # Each endpoint self-registers when it (de)serializes the transferred port.
      def port_channel_endpoint_realm(channel, realm_id)
        ch = (@port_channels[channel.to_s] ||= {})
        ch[:realm] = realm_id.to_i
        # Flush anything the worker posted before this endpoint was known (deliver_worker_messages).
        if (pending = ch.delete(:pending_realm))
          pending.each {|d| deliver_port_to_realm(realm_id.to_i, channel.to_s, d) }
        end
        nil
      end
      # Deliver a channel message into a client realm's endpoint port (realm 0 = the main realm).
      private def deliver_port_to_realm(rid, channel, data)
        if rid.zero?
          @runtime.call('__csimPortChannelDeliver', channel, data)
        elsif @runtime.frame_realm_alive?(rid)
          @runtime.realm_call(rid, '__csimPortChannelDeliver', channel, data)
        end
      end
      def port_channel_endpoint_sw(channel, handle)
        ch = (@port_channels[channel.to_s] ||= {})
        ch[:sw] = handle.to_i
        # Flush anything the client posted before this endpoint was known (see client_port_post).
        if (pending = ch.delete(:pending_sw)) && (w = @workers[handle.to_i])
          pending.each {|d| @sw_message_pending += 1; w[:inbox] << {kind: 'port_msg', channel: channel.to_s, data: d} }
        end
        nil
      end
      # A client-realm port posts to its remote (worker/SW) peer: relay to the isolate's inbox.
      # Counted like an sw_message so settle waits for the worker to process it (and any reply it
      # posts straight back on the same or another channel). A message posted BEFORE the peer endpoint
      # is registered (a port used right after transfer, before the worker decoded it — the Comlink
      # handshake) is BUFFERED on the channel and flushed by port_channel_endpoint_sw, per HTML's port
      # message queue, rather than dropped.
      def client_port_post(channel, data)
        ch = (@port_channels[channel.to_s] ||= {})
        handle = ch[:sw]
        if handle && (w = @workers[handle])
          @sw_message_pending += 1
          w[:inbox] << {kind: 'port_msg', channel: channel.to_s, data: data.to_s}
        else
          (ch[:pending_sw] ||= []) << data.to_s
        end
        nil
      end

      # The active fetch-handling worker controlling a navigation to `url`. nil when uncontrolled
      # or the SW is known to have no fetch listener (→ load from the network).
      private def sw_controller_for_navigation(url)
        match = sw_scope_match(url) or return nil
        handle = match[0]
        w = @workers[handle] or return nil
        # has_fetch is published from the worker thread AFTER its initial eval, so a navigation
        # into a freshly-activated registration can read it as nil (unknown) — race-prone for the
        # 2nd+ registration, whose initial load fires before the publish. Treat unknown as "maybe":
        # route through and let the fetch dispatch fall through if the SW turns out to have no
        # handler. Skip only a KNOWN-false (messaging/push-only) SW, or one whose thread is already
        # DEAD (crashed during eval / closed) — routing there would just stall the nav for the full
        # round-trip budget with no one to answer.
        return nil if w[:has_fetch] == false || !w[:thread]&.alive?

        handle
      end

      # Route a navigation request (document / iframe load) to its controlling SW's `fetch`
      # event and BLOCK for the respondWith result. Mirrors settle's bounded wait: the main
      # thread releases the GVL on the dedicated `@sw_nav_outbox`, so the worker thread runs the
      # handler and posts back. Navigation ids are NEGATIVE so the response is delivered on that
      # queue (sw_deliver_fetch_response), not the general outbox. Returns the parsed response
      # hash (SW served the document), or nil to load from the network (no controller, no
      # respondWith, network error, or the SW didn't answer within the round-trip budget).
      def service_worker_navigation_fetch(url, is_reload: false, is_history: false, referrer_source: nil, method: 'GET', body_b64: '', content_type: nil)
        handle = sw_controller_for_navigation(url) or return nil
        w      = @workers[handle] or return nil
        fetch_id = (@sw_nav_seq -= 1)
        # A form submission navigates with the form's method + encoded body (a POST nav the SW reads
        # via `event.request.text()`); the Content-Type the form's enctype implies rides its headers.
        headers = {'Accept' => 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'}
        headers['Content-Type'] = content_type.to_s unless content_type.to_s.empty?
        req = JSON.generate(
          method:              method.to_s.empty? ? 'GET' : method.to_s.upcase,
          url:                 url.to_s,
          # The Accept header Fetch inserts for a navigation request (destination 'document').
          headers:             headers,
          body_b64:            body_b64.to_s,
          mode:                'navigate',
          destination:         'document',
          isReloadNavigation:  is_reload,
          isHistoryNavigation: is_history,
          # A reload navigation revalidates (cache mode 'no-cache'); a fresh/history load is 'default'.
          cache:               is_reload ? 'no-cache' : 'default',
          # The navigation's referrer is the initiating document (the frame's parent), resolved
          # under its referrer policy — the document default absent a meta/header (strict-origin-
          # when-cross-origin), so a same-origin nav keeps the full URL.
          referrer:            compute_referrer(nil, referrer_source, url.to_s).to_s
        )
        w[:inbox] << {kind: 'fetch', req:, fetch_id:}
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + WORKER_ROUND_TRIP_BUDGET
        while Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
          ev = pop_with_timeout(@sw_nav_outbox, WORKER_POLL_INTERVAL) or next
          next unless ev[:fetch_id] == fetch_id   # discard a stale response from a timed-out nav

          resp = JSON.parse(ev[:resp])
          return nil                        if resp['fallthrough']    # no respondWith → load from the network
          return {'networkError' => true}   if resp['networkError']   # respondWith(Response.error()) → failed navigation

          return resp
        end
        nil   # SW never answered within budget → load from the network
      end

      def worker_terminate(handle)
        w = @workers.delete(handle.to_i)
        return unless w
        w[:inbox] << :terminate
        # Most clean shutdowns are <10 ms; the kill is the fallback
        # for blocked workers. Join again AFTER the kill so the thread is actually
        # dead before we revoke its URLs — `Thread#kill` is async, and a worker
        # still running a `createObjectURL` could otherwise re-register a URL after
        # the revoke and leak it.
        w[:thread].join(WORKER_TERMINATE_GRACE)
        if w[:thread].alive?
          w[:thread].kill
          w[:thread].join(WORKER_TERMINATE_GRACE)
        end
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
        # Drop any navigation scope mirrored to this now-dead worker so a later navigation
        # doesn't route to it (it falls through to the network instead).
        @sw_registrations.reject! {|_scope, h| h == handle.to_i }
        # A blocked worker that never returned messages leaves
        # `@worker_in_flight` permanently > 0; reset when no workers
        # remain so `polling?` can short-circuit again.
        (@worker_in_flight = 0; @worker_broadcast_pending = 0; @sw_message_pending = 0; @sw_fetch_pending = 0; @sw_fetch_wait_deadline = nil; @sw_clients = {}; @sw_realm_controller = {}; @port_channels = {}; @sw_pending_claims = []; @sw_open_streams.clear) if @workers.empty?
        # The worker is gone — revoke the blob URLs it created.
        revoke_worker_blobs(handle.to_i)
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
        port_ends,   rest0b = rest0.partition  {|e| e[:kind] == 'port_endpoint' }
        port_msgs,   rest0c = rest0b.partition {|e| e[:kind] == 'port_msg' }
        sw_msgs,     rest1  = rest0c.partition {|e| e[:kind] == 'sw_client_msg' }
        swacks,      rest2  = rest1.partition  {|e| e[:kind] == 'swack' }
        claims,      rest3  = rest2.partition  {|e| e[:kind] == 'sw_claim' }
        fetch_resps,   rest4  = rest3.partition  {|e| e[:kind] == 'fetch_response' }
        stream_frames, rest4b = rest4.partition  {|e| e[:kind].to_s.start_with?('fr_') }
        acks,          msgs   = rest4b.partition {|e| e[:kind] == 'bcack' }
        broadcasts.each {|e| broadcast_to_windows(e[:name], e[:data], nil, e[:origin], from_worker: e[:handle]) }
        # A worker/SW registering its end of a cross-isolate MessagePort channel — record it BEFORE
        # the message events below, so a port message carried in the same drain can already route.
        port_ends.each {|e| port_channel_endpoint_sw(e[:channel], e[:handle]) }
        # A worker/SW port → its remote (client-realm) peer: relay to that realm's channel endpoint.
        # If the client hasn't registered its endpoint yet (it decodes the transferred port in the
        # sw_client_msg processed just below), BUFFER until port_channel_endpoint_realm flushes.
        port_msgs.each do |e|
          ch  = (@port_channels[e[:channel].to_s] ||= {})
          rid = ch[:realm]
          if rid.nil?
            (ch[:pending_realm] ||= []) << e[:data]
          else
            deliver_port_to_realm(rid, e[:channel].to_s, e[:data])
          end
        end
        # A service worker → client message: deliver to the POSTING client's realm. The client id
        # encodes it — `client-<realm>` for a frame/window realm, 'client-window' for the main realm.
        # A `client.postMessage` to a controlled IFRAME must reach THAT frame's navigator.service-
        # Worker, not the top window (postmessage-to-client). `e[:handle]` is the SENDING worker, so
        # the client's message `source` is exact. A message to a DISCARDED frame realm is dropped
        # (matching a real browser — a message to a gone client is discarded, not misrouted to top).
        sw_msgs.each do |e|
          m = /\Aclient-(\d+)\z/.match(e[:client].to_s)
          if m
            rid = m[1].to_i
            @runtime.realm_call(rid, '__csim_swDeliverClientMessage', e[:data], e[:handle]) if @runtime.frame_realm_alive?(rid)
          else
            @runtime.call('__csim_swDeliverClientMessage', e[:data], e[:handle])
          end
        end
        # clients.claim(): the claiming worker takes control of EVERY in-scope client — including
        # ones that never register()'d (an iframe built before the SW existed). See broadcast_claim.
        # Process LONGEST scope first: when nested-scope workers claim in the same drain, the deeper
        # registration must be installed before the shallower one runs, or a client the shallow claim
        # transiently seizes would fire a spurious extra controllerchange (a reload-on-controllerchange
        # page would double-fire). A claim whose scope isn't mirrored into @sw_registrations yet — the
        # worker fires activate→claim() decoupled from the CLIENT-side lifecycle that populates it — is
        # BUFFERED and flushed by sw_register_scope, so an `activate → clients.claim()` isn't lost.
        claims.map {|e| [e, @sw_registrations.key(e[:handle].to_i)] }
              .sort_by {|_e, scope| -(scope ? scope.length : -1) }
              .each do |e, scope|
          if scope
            broadcast_claim(e[:handle], e[:has_fetch], scope)
          else
            @sw_pending_claims << e
          end
        end
        # A controlled fetch's respondWith result → resolve the pending client fetch in the
        # realm that issued it (fetch ids are per-realm, so realm_id disambiguates collisions).
        fetch_resps.each {|e| @runtime.realm_call(e[:realm_id].to_i, '__csim_swControllerFetchResponse', e[:fetch_id], e[:resp]) }
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
        @sw_fetch_pending         = [0, @sw_fetch_pending - fetch_resps.size - stream_terminals].max
        @worker_broadcast_pending = [0, @worker_broadcast_pending - acks.size].max
        @sw_message_pending       = [0, @sw_message_pending - swacks.size].max
        # `__error` postbacks don't correspond to a prior post, so bottom out at zero.
        @worker_in_flight = [0, @worker_in_flight - msgs.size].max
        @runtime.call('__csim_deliverWorkerMessages', msgs) unless msgs.empty?
        events.size
      end

      def worker_pending? = !@worker_outbox.empty? || !@worker_outbox_head.nil? || @worker_in_flight > 0 || @worker_broadcast_pending > 0 || @sw_message_pending > 0 || @sw_fetch_pending > 0 || @worker_init_lock.synchronize { @worker_initializing } > 0

      # The subset of worker pendings whose outbox reply is CONTRACTUAL (bcack / swack /
      # fetch_response are posted under `ensure`, so they arrive even when the worker-side
      # handler raises). Safe for settle to block a bounded wait on — unlike @worker_in_flight
      # (a plain postMessage that a listen-only worker never answers) or @worker_initializing.
      def worker_reply_pending? = @worker_broadcast_pending > 0 || @sw_message_pending > 0 || @sw_fetch_pending > 0

      # ── Cross-window messaging (window.open / opener / postMessage) ──
      # Each window is a separate Browser/VM/isolate, so a reference to another
      # window can only be a proxy that forwards through the Driver. These
      # forward host-fn calls (invoked from THIS window's VM) to the Driver,
      # which routes to the target window's Browser.

      # `window.open(url, name)` from JS — returns the new (or reused, by name)
      # window's handle, or nil. The URL is resolved against THIS document so a
      # relative `window.open('/x')` targets the right origin/path.
      def open_child_window(url, name, opener_realm_id = 0)
        return nil unless @driver.respond_to?(:open_window_from_js)
        @driver.open_window_from_js(self, url.to_s, name.to_s, opener_realm_id.to_i)
      end

      # A `target=_blank`/named link/area activation from a frame or window realm in
      # THIS browser opens a new top-level auxiliary window. `opener` reflects
      # rel=opener (a bare target=_blank is noopener); the Driver forces noopener for
      # a cross-partition blob: target. `blob` is an optional click-time blob snapshot.
      def open_aux_from_realm(url, opener, blob)
        return unless @driver.respond_to?(:open_aux_window)
        snap = blob.is_a?(Hash) ? blob : nil
        @driver.open_aux_window(resolve_document_url(url.to_s), source: self, opener: !!opener, blob_snapshot: snap)
      end

      # Open a SAME-ORIGIN auxiliary window as a realm in THIS browser's isolate
      # (shared heap) rather than a separate Browser/VM, returning the new realm's
      # context id for `window.open` to wrap in a NATIVE WindowProxy — so
      # `popup.document` is a real same-isolate Document and cross-window adoptNode
      # works (dom/nodes/remove-and-adopt-thcrash). Returns nil to fall back to the
      # separate-VM aux-window path. First stage: about:blank only (a non-blank
      # same-origin URL still takes the aux path until realm URL-loading lands).
      def open_window_realm(url, name: nil, opener_realm_id: 0)
        return nil unless @runtime.respond_to?(:create_window_realm)
        return nil unless url.nil?
        @runtime.create_window_realm('', '', 'text/html', window_name: name, opener_id: opener_realm_id)
      end

      # `targetWindow.postMessage(data, origin)` — route to the target window's
      # inbox, tagged with this window as the source.
      def post_message_to_window(target_handle, data, origin)
        return unless @driver.respond_to?(:window_post_message)
        @driver.window_post_message(self, target_handle.to_s, data, origin.to_s)
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
      def window_history_go(handle, delta) = (@driver.respond_to?(:window_history_go) ? @driver.window_history_go(handle.to_s, delta.to_i) : false)
      def window_closed?(handle)       = @driver.respond_to?(:window_closed?)      ? @driver.window_closed?(handle.to_s)           : true
      def close_child_window(handle)   = (@driver.close_window(handle.to_s) if @driver.respond_to?(:close_window))
      def opener_handle                = @driver.respond_to?(:opener_handle_of)    ? @driver.opener_handle_of(self)                : nil
      # Fire an aux window's own window `load` (called by its opener, deferred).
      def fire_aux_window_load(handle)  = (@driver.fire_aux_window_load(handle.to_s) if @driver.respond_to?(:fire_aux_window_load))
      def fire_own_window_load          = (@runtime.call('__csimFireWindowLoad') rescue nil)

      # Queue a cross-window message for delivery into THIS window's VM (called
      # by the Driver on the target Browser). Delivered as a `message` event the
      # next time this window settles / ticks.
      def enqueue_window_message(data, origin, source_handle)
        @window_inbox << {'data' => data, 'origin' => origin.to_s, 'sourceHandle' => source_handle.to_s}
      end

      # Covers both cross-window postMessage AND BroadcastChannel — the two
      # cross-window event channels share these drain/pending hooks.
      def window_message_pending? = !@window_inbox.empty? || !@broadcast_inbox.empty?

      # A BroadcastChannel message queued for delivery to this Browser's channels.
      # `source_realm_id` is the posting realm's context id within THIS isolate (0 =
      # main), or nil when the post came from ANOTHER isolate (the Driver's cross-
      # window fanout) — a nil source matches no local realm, so it reaches every one.
      def enqueue_broadcast(name, data, source_realm_id = nil, origin = nil)
        @broadcast_inbox << {'name' => name.to_s, 'data' => data, 'source' => source_realm_id, 'origin' => origin}
      end

      # Fire queued cross-window messages (postMessage + BroadcastChannel).
      def deliver_window_messages
        n = 0
        unless @window_inbox.empty?
          events = @window_inbox.slice!(0, @window_inbox.length)
          @runtime.call('__csim_deliverWindowMessages', events)
          n += events.size
        end
        unless @broadcast_inbox.empty?
          events = @broadcast_inbox.slice!(0, @broadcast_inbox.length)
          # A BroadcastChannel reaches every same-origin browsing context EXCEPT the
          # poster. Within this isolate each browsing context is a realm, so deliver to
          # the main realm (0) and every live frame/window realm, skipping the realm
          # that posted (it already delivered to itself in-VM via `_bcChannels`). A nil
          # source (cross-isolate) is excluded from no realm.
          realm_ids = @runtime.respond_to?(:frame_realm_ids) ? @runtime.frame_realm_ids : []
          [0, *realm_ids].each do |target_id|
            batch = events.reject {|e| e['source'] == target_id }
            next if batch.empty?
            if target_id.zero?
              @runtime.call('__csim_deliverBroadcasts', batch)
            elsif @runtime.frame_realm_alive?(target_id)
              @runtime.realm_call(target_id, '__csim_deliverBroadcasts', batch)
            end
          end
          n += events.size
        end
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
        @driver.broadcast_channel(self, name.to_s, data, origin) if @driver.respond_to?(:broadcast_channel)
        # Same-isolate main + frame realms. The poster already delivered to itself in-VM, so this
        # only reaches the OTHER realms — queue whenever one exists. A WORKER post reaches realm 0
        # and every frame (a separate isolate delivered to none in-VM). A FRAME post always reaches
        # main realm 0 — even when the posting frame's own realm isn't yet recorded in `frame_realms`
        # (a BroadcastChannel posted SYNCHRONOUSLY during the frame's initial script runs before the
        # realm is registered, so `has_frames` can be false though a valid target — main — exists). A
        # MAIN post reaches the frames only when some are registered.
        has_frames = @runtime.respond_to?(:frame_realm_ids) && @runtime.frame_realm_ids.any?
        from_frame = !from_worker && !source_realm_id.nil? && source_realm_id != 0
        enqueue_broadcast(name, data, source_realm_id, origin) if has_frames || from_worker || from_frame
        # Every WORKER is a separate isolate reached via its thread-safe inbox — deliver to each live
        # one except the posting worker. Skip a worker whose thread has already exited (self-close /
        # termination in flight): it will never drain its inbox, so pushing would leak. Counted in a
        # dedicated pending tally so `settle` waits until the worker acks the delivery (a `bcack`).
        @workers.each do |h, w|
          next if h == from_worker || !w[:thread].alive?
          @worker_broadcast_pending += 1
          w[:inbox] << {kind: 'broadcast', name: name.to_s, data: data, origin: origin}
        end
      end

      # ── Image decode (libvips) ─────────────────────────────────────
      #
      # Called by the JS bridge whenever a Canvas / OffscreenCanvas
      # path needs raw RGBA pixels — `drawImage(image, …)` whose
      # source is an HTMLImageElement / Blob / ImageBitmap with
      # encoded bytes still on the wire. ruby-vips decodes any format
      # libvips supports (PNG, JPEG, WebP, GIF, …) into a contiguous
      # row-major RGBA buffer. Returns `{width, height, refId}` — the
      # raw bytes land in the transfer-buffer registry so the JS side
      # fetches them as a `Uint8Array` (tag-driven binary marshalling) rather
      # than building a 423 MB latin-1 + base64 intermediate for the
      # 8900×8900 frames Discourse uploads exercise. Optional
      # `max_w`/`max_h` lets the caller pre-shrink for cheap OCR-style
      # "downscale before pixel-touch" flows.
      # Load an image resource for an `<img>` (or a pattern/drawImage source):
      # resolve the URL against the current document, fetch the bytes, and decode
      # them to an RGBA buffer via libvips. Returns `{width, height, refId}` (the
      # raw pixels ride the transfer registry, like decode_image) or nil when the
      # fetch or decode fails (a broken image → the `<img>` fires `error`).
      # Fetch + decode an `<img>` resource to an RGBA bitmap for the drawImage /
      # createPattern surface, memoized by resolved URL (see `@@image_cache`). Returns
      # {'width','height','refId'} — a FRESH transfer stash per call, since
      # `fetchTransfer` consumes the registry entry — or nil when the resource can't be
      # fetched or decoded (the caller fires `error`). A scheme with no host-side reader
      # yet (blob:, whose bytes live in the VM) returns {'unsupported' => true} so the
      # caller stays inert rather than reporting a spuriously-broken image.
      def load_image(url)
        key = resolve_against_current(url.to_s)
        return nil unless key.is_a?(String)
        entry = cached_image(key)
        return {'unsupported' => true} if entry == :unsupported
        # A valid zero-area image: complete + not broken, but no pixels. rsvg throws
        # before dimensions can be read, so the intrinsic size collapses to 0×0 (a
        # browser would keep the non-zero axis, e.g. 0×100 → naturalHeight 100) — a minor
        # divergence, immaterial to createPattern / drawImage, which both need a
        # non-zero area.
        return {'zeroSize' => true, 'width' => 0, 'height' => 0} if entry == :zero_size
        return nil unless entry
        r = {'width' => entry['width'], 'height' => entry['height'], 'refId' => transfer_buffer_stash(entry['bytes']), 'colorSpace' => entry['colorSpace']}
        r['refIdP3'] = transfer_buffer_stash(entry['bytesP3']) if entry['bytesP3']
        r
      end

      # A decoded-image cache entry for `key`, decoding + caching on a miss.
      # :unsupported for a scheme we can't fetch host-side; nil on fetch/decode failure.
      private def cached_image(key)
        cached = @@image_cache_lock.synchronize { @@image_cache[key] }
        return cached if cached
        bytes = image_source_bytes(key)
        return bytes if bytes == :unsupported
        return nil unless bytes
        entry = decode_or_nil(bytes)
        # nil (broken) and :zero_size (valid but zero-area) both carry no bitmap to cache.
        return entry unless entry.is_a?(Hash)
        @@image_cache_lock.synchronize do
          @@image_cache.clear if @@image_cache.size >= IMAGE_CACHE_MAX
          @@image_cache[key] = entry
        end
        entry
      end

      # Raw (encoded) bytes for an image URL: `data:` decoded inline, http(s) via a
      # binary-safe fetch (the raw bytes ride `body_b64`; the text body would mangle
      # non-ASCII image bytes). :unsupported for a scheme with no host-side reader,
      # nil for a missing / failed / empty resource.
      private def image_source_bytes(key)
        if key.start_with?('data:')
          bytes = decode_data_url_body(key)
          bytes.empty? ? nil : bytes
        elsif key.match?(%r{\Ahttps?://}i)
          result = rack_fetch('GET', key, '', {}, 'follow')
          return nil unless result && result['status'].to_i < 400
          bytes = result['body_b64'] ? Base64.decode64(result['body_b64']) : result['body'].to_s.b
          bytes.empty? ? nil : bytes
        else
          :unsupported
        end
      end

      # Decode a base64-encoded image (createImageBitmap's blob path), optionally
      # downscaled to fit within (max_w, max_h) via its resize options.
      def decode_image(b64_bytes, max_w = nil, max_h = nil)
        entry = decode_or_nil(Base64.decode64(b64_bytes.to_s), max_w, max_h)
        # nil (broken) or :zero_size — createImageBitmap of either rejects (a zero-area
        # source is an InvalidStateError), so surface nil for the caller to reject on.
        return nil unless entry.is_a?(Hash)
        r = {'width' => entry['width'], 'height' => entry['height'], 'refId' => transfer_buffer_stash(entry['bytes']), 'colorSpace' => entry['colorSpace']}
        r['refIdP3'] = transfer_buffer_stash(entry['bytesP3']) if entry['bytesP3']
        r
      end

      # Decode an encoded image (PNG/JPEG/GIF/WEBP/SVG/…) to a packed RGBA bitmap via
      # libvips, optionally downscaled to fit within (max_w, max_h). `access:
      # :sequential` keeps libvips from applying the source ICC profile mid-stream (it
      # shifts RGBA by ±2 vs a raw decode). Returns {'width','height','bytes','colorSpace'};
      # `colorSpace` ('srgb' | 'display-p3') tells drawImage which space the bytes are in
      # so it can convert into the destination canvas's colour space.
      #
      # Detection is by the profile's description text (both Display-P3 and the sRGB /
      # Adobe profiles carry a readable name). A plain (unprofiled) OR sRGB-profiled RGB
      # image is trusted as sRGB verbatim — the common case (incl. photos exported as
      # sRGB) stays byte-identical. A Display-P3 image keeps its raw bytes: a Display-P3
      # PNG already stores P3-encoded values, so we only TAG it and let drawImage do the
      # gamut conversion. Adobe-RGB and CMYK aren't among the two predefined canvas colour
      # spaces, so they're ICC-transformed to sRGB (their wide gamut is lost — a documented
      # gap). Any other profiled non-RGB source (grayscale / Lab) is colour-converted to
      # sRGB so it lands as packed RGB, never kept raw.
      private def decode_rgba(bytes, max_w = nil, max_h = nil)
        require 'vips' unless defined?(Vips)
        img = Vips::Image.new_from_buffer(bytes, '', access: :sequential)
        # RGB (incl. 16-bit `rgb16`); a non-RGB profiled source is colour-converted below.
        rgb = %i[srgb rgb rgb16].include?(img.interpretation)
        color_space = 'srgb'
        p3_img = nil   # a second, Display-P3 rendering for a wide-gamut source (see below)
        if img.get_fields.include?('icc-profile-data')
          icc = img.get('icc-profile-data')
          if rgb && (icc.include?('Display P3') || icc.include?('DCI-P3'))
            color_space = 'display-p3'   # wide-gamut RGB: raw bytes are already P3-encoded
          elsif img.interpretation == :cmyk || icc.include?('Adobe')
            # A wide-gamut (Adobe-RGB / CMYK) profile can't be represented by a single
            # buffer: an sRGB canvas needs the colour CLIPPED to sRGB, a Display-P3 canvas
            # needs it PRESERVED in P3 (and those differ — ICC gamut-mapping to sRGB isn't a
            # matrix clip of the P3 value). So decode BOTH renderings via libvips' built-in
            # profiles; drawImage picks by the destination canvas's colour space. icc_transform
            # needs random access, so re-decode without `access: :sequential`.
            base = Vips::Image.new_from_buffer(bytes, '')
            begin
              img    = base.icc_transform('srgb', embedded: true)
              p3_img = base.icc_transform('p3',   embedded: true)
            rescue StandardError
              img = img.colourspace('srgb'); p3_img = nil
            end
          elsif !rgb
            img = img.colourspace('srgb')   # profiled grayscale / Lab → packed sRGB RGB
          end
          # else: an sRGB-profiled (or other) RGB image → trust the raw bytes as sRGB.
        elsif !rgb
          img = img.colourspace('srgb')
        end
        pack = lambda do |i|
          i = i.cast('uchar', shift: true) if i.format == :ushort   # 16-bit source → 8-bit, scaled
          i = i.bandjoin(255) if i.bands < 4
          i
        end
        img    = pack.call(img)
        p3_img = pack.call(p3_img) if p3_img
        if max_w && max_h && max_w.to_i > 0 && max_h.to_i > 0 &&
           (img.width > max_w.to_i || img.height > max_h.to_i)
          shrink = [img.width.to_f / max_w.to_i, img.height.to_f / max_h.to_i].max
          if shrink > 1
            img    = img.resize(1.0 / shrink)
            p3_img = p3_img.resize(1.0 / shrink) if p3_img
          end
        end
        out = {'width' => img.width, 'height' => img.height, 'bytes' => img.write_to_memory, 'colorSpace' => color_space}
        # The P3 rendering is best-effort: libvips is lazy, so an ICC fault surfaces only
        # here at sink evaluation — it must not break the already-rendered sRGB image, just
        # drop the wide-gamut variant (that image then won't preserve wide colours in a P3 canvas).
        if p3_img
          begin
            out['bytesP3'] = p3_img.write_to_memory
          rescue StandardError
            nil
          end
        end
        out
      end

      # `decode_rgba` guarded. Outcomes:
      #   Hash       — a decoded {'width','height','bytes'} bitmap
      #   :zero_size — a VALID image with a non-positive intrinsic dimension (rsvg refuses
      #                to rasterize an SVG whose width|height is 0). Browsers still load it,
      #                reporting a zero-area bitmap, so this is "available but empty"
      #                (bad usability → createPattern null / drawImage no-op), NOT broken.
      #   nil        — an undecodable / corrupt body: a normal "broken image" outcome
      #                (the caller fires `error` / rejects the ImageBitmap promise)
      # A Vips::Error is a quiet outcome, not stderr noise; genuine host faults (missing
      # libvips, OOM) still warn via `host_image_op`. The `bad dimensions` signal is the
      # rsvg loader's own diagnostic for a non-positive canvas (libvips-version-coupled
      # text; a corrupt raster / malformed SVG raises a different, non-matching message);
      # it also covers a fully DIMENSIONLESS SVG that a browser would instead render at
      # the 300×150 CSS default — a bounded, documented divergence, still a net
      # improvement over the old nil→broken→InvalidStateError.
      private def decode_or_nil(bytes, max_w = nil, max_h = nil)
        require 'vips' unless defined?(Vips)
        decode_rgba(bytes, max_w, max_h)
      rescue Vips::Error => e
        e.message.include?('bad dimensions') ? :zero_size : nil
      rescue LoadError, StandardError => e
        warn "[capybara-simulated] image decode failed: #{e.class}: #{e.message[0, 200]}"
        nil
      end

      private def host_image_op(name)
        yield
      rescue LoadError, StandardError => e
        warn "[capybara-simulated] #{name} failed: #{e.class}: #{e.message[0, 200]}"
        nil
      end

      # Render a line of text to a coverage mask via libvips (pango / fontconfig),
      # backing the canvas `fillText` / `measureText` surface with real system-font
      # glyphs and metrics — no bundled font, so any installed family works. `font`
      # is a pango font string ("Sans Bold 16"); at dpi 72 the point size equals CSS
      # px. Returns `{width, height, xoffset, yoffset, ascent, descent[, refId]}`:
      # the image is cropped to the INK box, and (xoffset, yoffset) locate that box
      # within the logical layout, so the JS side can place the alphabetic baseline.
      # `measure_only` skips rasterizing the mask (the lazy image already knows its
      # dimensions) — the cheap path for `measureText`.
      def render_text(text, font, measure_only = false, font_url = nil, kerning = nil)
        host_image_op('render_text') {
          require 'vips' unless defined?(Vips)
          pango = font.to_s.empty? ? 'Sans 10' : font.to_s
          fontfile = font_url && !font_url.to_s.empty? ? font_file_for(font_url) : nil
          # Ascent/descent are properties of the FONT, not the variant: probe them with a
          # small-caps-stripped description so the descender probe ('gjpqy') isn't rendered
          # as (descenderless) small capitals, which would collapse the reported descent.
          asc, desc = font_vmetrics(pango.sub(/ Small-Caps\b/i, ''), fontfile)
          # NUL takes up no space and would abort the pango render; drop it so a lone
          # "\0" measures/draws as empty rather than falling back to a fabricated width.
          str = text.to_s.delete("\u0000")
          return {'width' => 0, 'advance' => 0, 'height' => 0, 'xoffset' => 0, 'yoffset' => 0, 'ascent' => asc, 'descent' => desc} if str.empty?

          # `Vips::Image.text` parses Pango markup — canvas text is always literal,
          # so escape the markup metacharacters (an unescaped `&`/`<` would raise,
          # silently dropping the text; `<b>…` would wrongly render as bold).
          markup = str.gsub('&', '&amp;').gsub('<', '&lt;').gsub('>', '&gt;')
          # `fontKerning = 'none'` disables the OpenType `kern` feature via a Pango markup
          # span, so a system font's rendered advance widens to the un-kerned width. ('auto'
          # / 'normal' leave pango's default kerning on.) A downloaded font's advance comes
          # from hmtx and is unaffected.
          markup = %(<span font_features="kern=0">#{markup}</span>) if kerning == 'none'
          # Render the whole line at its natural width; the caller condenses it
          # horizontally to honor canvas maxWidth (pango `width:` would word-WRAP,
          # which the canvas text algorithm never does). An @font-face family loads its
          # own font via `fontfile:` so pango resolves it (vips needs fontconfig support).
          img = text_image(markup, pango, fontfile)
          # `width` is the INK width (vips crops to it); `advance` is the pen movement
          # (`measureText().width`), which a downloaded font's hmtx gives exactly and
          # which falls back to the ink width for a system font we can't parse — or for a
          # string whose codepoints the (BMP) cmap doesn't map yet still renders ink
          # (astral / symbol-cmap), where a computed 0 advance would be wrong.
          adv = fontfile && font_advance_px(pango, fontfile, str)
          advance = adv && adv > 0 ? adv : img.width
          em_asc, em_desc = fontfile ? font_em_vmetrics(pango, fontfile) : nil
          res = {
            'width'    => img.width,
            'advance'  => advance,
            'height'   => img.height,
            'xoffset'  => img.get('xoffset'),
            'yoffset'  => img.get('yoffset'),
            'ascent'   => asc,
            'descent'  => desc,
            'emAscent'  => em_asc || asc,
            'emDescent' => em_desc || desc
          }
          res.merge!(font_base_metrics(pango, fontfile) || {}) if fontfile   # BASE-table baselines, when present
          unless measure_only
            img = img.cast('uchar') unless img.format == :uchar
            res['refId'] = transfer_buffer_stash(img.write_to_memory)
          end
          res
        }
      end

      # `Vips::Image.text` with the optional `fontfile:` (an @font-face's downloaded
      # font), which pango loads so it can resolve that family. Passing a nil fontfile
      # would raise, so branch — a system-font family resolves through fontconfig.
      private def text_image(markup, pango, fontfile)
        if fontfile
          Vips::Image.text(markup, font: pango, fontfile: fontfile, dpi: 72)
        else
          Vips::Image.text(markup, font: pango, dpi: 72)
        end
      end

      # Ascent (baseline offset from the logical top) and descent for a pango font,
      # probed once and cached. A no-descender cap/ascender string's ink bottom is
      # the baseline (ascent); a descender string's ink bottom minus that is the
      # descent. dpi 72 keeps units in CSS px. `fontfile` (an @font-face font) is part
      # of the cache key so a downloaded family's metrics don't collide with a system one.
      private def font_vmetrics(pango, fontfile = nil)
        key = fontfile ? "#{pango}\0#{fontfile}" : pango
        cached = @font_vmetrics_lock.synchronize { @font_vmetrics[key] }
        return cached if cached

        # A downloaded @font-face carries its own typographic metrics, and pango lays
        # it out on those, so the baseline (ascent) comes from the font's OS/2 typo
        # ascender/descender scaled to the pixel size — the ink-string heuristic below
        # is only a fallback for the ambient system font, whose file we don't have.
        asc, desc = font_typo_vmetrics(pango, fontfile) if fontfile
        unless asc
          asc = begin
            r = text_image('Mbdfhklt', pango, fontfile)
            r.get('yoffset') + r.height
          rescue StandardError
            10
          end
          desc = begin
            r = text_image('gjpqy', pango, fontfile)
            [(r.get('yoffset') + r.height) - asc, 0].max
          rescue StandardError
            (asc * 0.25).round
          end
        end
        @font_vmetrics_lock.synchronize { @font_vmetrics[key] ||= [asc, desc] }
      end

      # [ascent, descent] in px from a font file's OS/2 typographic metrics scaled to
      # the pango string's point size (dpi 72 → px), or nil if it can't be read. This is
      # the FONT bounding box / baseline value (fontBoundingBoxAscent), typo-ascender
      # over unitsPerEm.
      private def font_typo_vmetrics(pango, fontfile)
        m = font_typo_units(fontfile) or return nil
        upm, ta, td = m
        size = font_size_of(pango)
        [(ta * size / upm).round, [(-td * size / upm).round, 0].max]
      end

      # [emHeightAscent, emHeightDescent] in px: the em square (= font size) split by the
      # baseline at the typo ascender:descender ratio — NOT normalized by unitsPerEm, so a
      # font whose ascender+descender ≠ em still fills the em (e.g. descent-0 → all ascent).
      private def font_em_vmetrics(pango, fontfile)
        m = font_typo_units(fontfile) or return nil
        _upm, ta, td = m
        span = ta + (-td)
        return nil unless span.positive?
        size = font_size_of(pango)
        ea = size * ta / span.to_f
        [ea.round, (size - ea).round]
      end

      # The point size in a pango font string ("CanvasTest 40" → 40); 10 as a fallback.
      # The size is a whitespace-separated trailing token, so a family that itself ends
      # in a digit ("B612") without a size isn't misread as one.
      private def font_size_of(pango)
        size = pango.to_s[/\s(\d+(?:\.\d+)?)\s*\z/, 1].to_f
        size.positive? ? size : 10.0
      end

      # [unitsPerEm, sTypoAscender, sTypoDescender] from a TrueType/OpenType file's
      # `head` + `OS/2` tables, or nil.
      private def font_typo_units(fontfile)
        g = font_glyph_data(fontfile) or return nil
        [g[:upm], g[:typo_asc], g[:typo_desc]]
      end

      # The advance width (pen movement) of `text` in the font, in px at the pango
      # string's size — the value `measureText().width` reports. vips crops to ink, so
      # the advance (which includes side bearings) comes from the font's own hmtx table.
      # nil if the font can't be parsed.
      private def font_advance_px(pango, fontfile, text)
        g = font_glyph_data(fontfile) or return nil
        size = font_size_of(pango)
        units = text.to_s.each_char.sum do |ch|
          gid = g[:cmap][ch.ord]
          next 0 unless gid   # a codepoint the font doesn't map (null, control) advances nothing
          g[:advances][gid] || g[:advances].last || 0
        end
        units * size / g[:upm]
      end

      # Parse the glyph tables a canvas text metric needs out of a TrueType/OpenType
      # file, memoized per path: unitsPerEm + typo metrics (head / OS/2), the per-glyph
      # advance widths (hmtx), and a Unicode → glyph-id map (cmap format 4). nil when a
      # required table is missing or malformed.
      private def font_glyph_data(fontfile)
        (@font_glyph ||= {})
        return @font_glyph[fontfile] if @font_glyph.key?(fontfile)
        @font_glyph[fontfile] = parse_font_glyph_data(fontfile)
      end

      private def parse_font_glyph_data(fontfile)
        data = File.binread(fontfile)
        n = data[4, 2].unpack1('n')
        tabs = {}
        12.step(12 + (n - 1) * 16, 16) { |o| tabs[data[o, 4]] = data[o + 8, 4].unpack1('N') }
        head = tabs['head']; os2 = tabs['OS/2']; hhea = tabs['hhea']; hmtx = tabs['hmtx']; cmap = tabs['cmap']
        return nil unless head && hhea && hmtx && cmap
        upm = data[head + 18, 2].unpack1('n')
        return nil unless upm.positive?
        num_h = data[hhea + 34, 2].unpack1('n')
        advances = (0...num_h).map { |i| data[hmtx + i * 4, 2].unpack1('n') }
        {
          upm:       upm,
          typo_asc:  s16(data[(os2 || hhea) + (os2 ? 68 : 4), 2]),
          typo_desc: s16(data[(os2 || hhea) + (os2 ? 70 : 6), 2]),
          advances:  advances,
          # A malformed cmap shouldn't discard the (already-read) upm / advances / typo
          # metrics, so isolate its parse — an empty map just means advances fall back.
          cmap:      (parse_cmap4(data, cmap) rescue {}),
          # Optional horizontal-baseline coordinates ({tag => font units}) from the `BASE`
          # table — the alphabetic / hanging / ideographic baselines measureText reports.
          base:      (tabs['BASE'] ? (parse_base_table(data, tabs['BASE']) rescue {}) : {}),
        }
      rescue StandardError
        nil
      end

      # Horizontal-axis baseline coordinates ({"hang"/"ideo"/"romn"/… => font units},
      # relative to the script's default baseline) from the first BASE-table script's
      # BaseValues. Empty when the table is absent or has no coordinates.
      private def parse_base_table(data, base_off)
        horiz_rel = data[base_off + 4, 2].unpack1('n')          # horizAxisOffset (0 = none)
        return {} if horiz_rel.zero?
        horiz = base_off + horiz_rel
        tag_list = horiz + data[horiz, 2].unpack1('n')          # baseTagList (rel. to axis)
        script_list = horiz + data[horiz + 2, 2].unpack1('n')   # baseScriptList (rel. to axis)
        ntags = data[tag_list, 2].unpack1('n')
        nscript = data[script_list, 2].unpack1('n')
        # A count read past a truncated table is nil; `(0...nil)` is an ENDLESS range that
        # would loop forever (never raising, so the caller's `rescue {}` can't save it).
        return {} if ntags.nil? || nscript.nil? || nscript.zero?
        tags = (0...ntags).map { |i| data[tag_list + 2 + i * 4, 4] }
        # Prefer the DFLT / latn script's baselines; else the first record.
        recs = (0...nscript).map { |i| o = script_list + 2 + i * 6; [data[o, 4], script_list + data[o + 4, 2].unpack1('n')] }
        _tag, s_off = recs.find { |t, _| t == 'DFLT' || t == 'latn' } || recs.first
        bv_rel = data[s_off, 2].unpack1('n')                    # baseValuesOffset (0 = none)
        return {} if bv_rel.zero?
        bv = s_off + bv_rel
        ncoord = data[bv + 2, 2].unpack1('n')
        out = {}
        tags.each_with_index do |t, i|
          break if i >= ncoord
          co = bv + data[bv + 4 + i * 2, 2].unpack1('n')
          out[t] = s16(data[co + 2, 2]) if [1, 2, 3].include?(data[co, 2].unpack1('n'))   # BaseCoord formats
        end
        out
      end

      # The alphabetic / hanging / ideographic baselines (px at the pango size) from the
      # font's BASE table, or nil when the font has none — then the caller heuristically
      # derives them from the vertical metrics instead.
      private def font_base_metrics(pango, fontfile)
        g = font_glyph_data(fontfile) or return nil
        base = g[:base]
        return nil if base.nil? || base.empty?
        scale = font_size_of(pango) / g[:upm].to_f
        romn = base['romn'] || 0                                # the alphabetic baseline = the reference
        {
          'alphabeticBaseline'  => 0.0,
          'hangingBaseline'     => ((base['hang'] || romn) - romn) * scale,
          'ideographicBaseline' => ((base['ideo'] || romn) - romn) * scale,
        }
      end

      # A Unicode → glyph-id map from the first format-4 `cmap` subtable (the standard
      # BMP Unicode encoding), as {codepoint => glyph}. Empty when none is present.
      private def parse_cmap4(data, cmap)
        ntab = data[cmap + 2, 2].unpack1('n')
        return {} if ntab.nil?   # a count read past a truncated table → don't loop `(0...nil)` forever
        # Prefer a Unicode BMP subtable — (3,1) Windows Unicode or (0,*) Unicode — over a
        # (3,0) Symbol map (which shadows ASCII into the 0xF000 PUA); fall back to any
        # format-4 table only if no Unicode one is present.
        best = nil; best_rank = -1
        (0...ntab).each do |i|
          rec = cmap + 4 + i * 8
          pid = data[rec, 2].unpack1('n'); eid = data[rec + 2, 2].unpack1('n')
          off = data[rec + 4, 4].unpack1('N')
          next unless data[cmap + off, 2].unpack1('n') == 4
          rank = pid == 3 && eid == 1 ? 3 : pid.zero? ? 2 : pid == 3 && eid.zero? ? 0 : 1
          if rank > best_rank then best_rank = rank; best = cmap + off end
        end
        sub = best
        return {} unless sub
        segx2 = data[sub + 6, 2].unpack1('n'); segc = segx2 / 2
        endc  = sub + 14
        startc = endc + segx2 + 2
        iddelta = startc + segx2
        idrange = iddelta + segx2
        map = {}
        (0...segc).each do |s|
          e  = data[endc + s * 2, 2].unpack1('n')
          st = data[startc + s * 2, 2].unpack1('n')
          delta = data[iddelta + s * 2, 2].unpack1('n')
          ro    = data[idrange + s * 2, 2].unpack1('n')
          (st..e).each do |c|
            next if c == 0xFFFF
            gid = if ro.zero?
                    (c + delta) & 0xFFFF
                  else
                    gi = idrange + s * 2 + ro + (c - st) * 2
                    g = data[gi, 2].unpack1('n')
                    g.zero? ? 0 : (g + delta) & 0xFFFF
                  end
            map[c] = gid if gid != 0
          end
        end
        map
      end

      # A big-endian signed 16-bit value.
      private def s16(bytes)
        v = bytes.unpack1('n')
        v >= 0x8000 ? v - 0x10000 : v
      end

      # Resolve an @font-face src URL to an on-disk font file pango can load, fetching
      # the bytes through the Rack app (binary-safe) once and caching the temp path for
      # the process. Returns nil when the fetch fails.
      def font_file_for(url)
        key = resolve_against_current(url.to_s)
        return nil unless key.is_a?(String)
        @@font_file_lock.synchronize { return @@font_file_cache[key] if @@font_file_cache.key?(key) }
        path = build_font_file(key)
        @@font_file_lock.synchronize { @@font_file_cache[key] = path }
        path
      end

      private def build_font_file(key)
        bytes = font_source_bytes(key)
        return nil unless bytes && !bytes.empty?
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
      # (the raw bytes ride `body_b64`; a text body would mangle the font's non-ASCII).
      private def font_source_bytes(key)
        if key.start_with?('data:')
          bytes = decode_data_url_body(key)
          bytes.empty? ? nil : bytes
        elsif key.match?(%r{\Ahttps?://}i)
          result = rack_fetch('GET', key, '', {}, 'follow')
          return nil unless result && result['status'].to_i < 400
          bytes = result['body_b64'] ? Base64.decode64(result['body_b64']) : result['body'].to_s.b
          bytes.empty? ? nil : bytes
        end
      end

      def reset_workers
        @workers.each_value do |w|
          w[:inbox] << :terminate
          w[:thread].kill
        end
        @workers.clear
        @worker_outbox.clear
        @worker_outbox_head       = nil
        @worker_in_flight         = 0
        @worker_broadcast_pending = 0
        @sw_message_pending       = 0
        @sw_fetch_pending         = 0
        @sw_open_streams.clear
        @sw_fetch_wait_deadline   = nil
        @sw_registrations.clear
        @sw_pending_claims   = []
        @sw_clients          = {}
        @sw_realm_controller = {}
        @port_channels       = {}
        @sw_nav_outbox.clear
        @transfer_buffer_lock.synchronize {
          @transfer_buffers.clear
          @transfer_buffer_seq = 0
        }
      end

      def blob_register(url, body_b64, owner_realm = nil)
        # Tag the creating context so the URL is revoked when that context goes
        # away: a WORKER (separate thread, tagged via Thread.current) when it
        # terminates ("Terminating worker"), or a FRAME REALM (owner_realm passed
        # from JS createObjectURL) when the iframe is removed ("Removing an
        # iframe"). Namespaced ('w:' / 'r:') so a worker handle and a realm id
        # never collide. Main-realm blobs (no owner) live until clear_volatile.
        worker = Thread.current[:csim_worker_handle]
        key = if worker then "w:#{worker}"
              elsif owner_realm && owner_realm.to_i != 0 then "r:#{owner_realm.to_i}"
              end
        @blob_registry_lock.synchronize do
          @blob_registry[url.to_s] = body_b64.to_s
          # Keep ownership in sync both ways: a (re-)registration with no owner
          # (main thread / main realm) must DROP any prior owner, else revoking
          # that context would wrongly revoke a now-page-owned URL.
          if key then @blob_owners[url.to_s] = key else @blob_owners.delete(url.to_s) end
        end
        # Record the blob's STORAGE PARTITION (this window's top-level site) in the
        # Driver-level store so another window can resolve it only from the same
        # partition (blob URL partitioning). Keyed by the creating Browser so the
        # bytes are read back from wherever they live (the creator's isolate).
        @driver.register_blob_partition(url.to_s, self, blob_partition_site) if @driver.respond_to?(:register_blob_partition)
        nil
      end

      def blob_resolve(url)
        # A same-partition blob created in another window/isolate is spec-fetchable
        # cross-window, but resolving its bytes means a real-time cross-isolate read
        # (+ worker round-trips for the worker variants) that races the per-example
        # timeout under suite load — flaky in the gate. So we only resolve a blob from
        # THIS window's registry; the cross-window same-partition fetch is a backlog
        # item (cross-partition.https "fetched from a same-partition {iframe,worker}").
        @blob_registry_lock.synchronize { @blob_registry[url.to_s] }
      end

      # The SITE (scheme + registrable domain) of this window's top-level document.
      # Storage partitioning keys a blob URL on its creator's top-level site, so a
      # same-origin iframe embedded in a cross-site top-level context is a DIFFERENT
      # partition and can't reach the blob. Registrable domain is approximated as the
      # host's last two dot-labels — correct for the single-label public suffixes our
      # in-process hosts use (web-platform.test / not-web-platform.test / *.com); a
      # full Public Suffix List isn't warranted here.
      def blob_partition_site
        # A blob: document's location is `blob:<innerURL>` (e.g.
        # `blob:https://host:port/uuid`) — strip the prefix so the site derives from
        # the inner origin, not the opaque blob: scheme. data:/about: have no host →
        # '' (an opaque origin, never same-partition with a real one).
        u = URI.parse(@current_url.to_s.sub(/\Ablob:/, ''))
        host = u.host.to_s
        return '' if host.empty?
        labels = host.split('.')
        # An IP literal (v4 dotted / v6 bracketed) or a ≤2-label host IS its own
        # registrable domain; otherwise approximate eTLD+1 as the last two labels
        # (no Public Suffix List — correct for the single-label TLDs our hosts use).
        regd = if host.start_with?('[') || host.match?(/\A\d+(\.\d+){3}\z/) || labels.length <= 2
          host
        else
          labels.last(2).join('.')
        end
        "#{u.scheme}://#{regd}"
      rescue URI::Error
        ''
      end

      # WHATWG URL "domain to ASCII" — the JS tr46 stub delegates non-ASCII / xn--
      # hosts here (the ASCII fast path stays in-VM). Returns the punycode form, or
      # nil on an IDNA failure (so whatwg-url reports "domain to ASCII failed").
      # `be_strict: false` is the URL parser's mode (UseSTD3ASCIIRules and
      # VerifyDnsLength off) — empty middle labels (`x..y`) and `_`/etc. are
      # allowed, matching whatwg-url's `domainToASCII(domain, false)`.
      def domain_to_ascii(domain)
        d = domain.to_s
        # An all-ASCII domain needs no IDNA mapping: WHATWG "domain to ASCII"
        # (beStrict false) keeps it verbatim and only ASCII-lowercases it — including
        # an `xn--` A-label whose punycode doesn't decode to a valid UTS46 label
        # (`xn--pokxncvks` → disallowed U+3253…, or the bare `xn--`). Browsers (and the
        # WPT urltestdata) keep those A-labels as-is; uri-idna RE-validates the decoded
        # label and raises, which would wrongly fail the parse. So route only domains
        # with non-ASCII codepoints (the ones that actually need punycode) through
        # uri-idna. Forbidden host code points in an ASCII host are caught separately
        # by whatwg-url's host parser, not here. (Residual: a host MIXING a non-ASCII
        # label with a non-decodable `xn--` label still routes through uri-idna and
        # fails — a narrow per-label gap no current test hits; the all-ASCII fast path
        # covers every observed case.)
        return d.downcase if d.ascii_only?
        URI::IDNA.whatwg_to_ascii(d, be_strict: false)
      rescue URI::IDNA::Error
        nil   # a genuine IDNA failure on a non-ASCII host (bad punycode / disallowed
              # codepoint) — let whatwg-url report "domain to ASCII failed". Non-IDNA
              # errors propagate.
      end

      # WHATWG URL "domain to Unicode" — best-effort (never fails the parse per
      # spec), so on an IDNA error fall back to the input domain (unlike to_ascii,
      # which signals failure with nil — the asymmetry is intentional).
      def domain_to_unicode(domain)
        URI::IDNA.whatwg_to_unicode(domain.to_s, be_strict: false)
      rescue URI::IDNA::Error
        domain.to_s
      end

      # Read a blob URL's bytes + content type from THIS window's VM (its local
      # blob store) — the Driver uses it to load a blob: document into a fresh aux
      # window opened by this window. Returns {bytes:, type:} or nil.
      def read_blob_for_window(url)
        r = @runtime.call('__csimReadBlobForWindow', url.to_s)
        return nil unless r.is_a?(Hash) && r['b64']
        { bytes: Base64.decode64(r['b64'].to_s), type: r['type'].to_s }
      rescue StandardError
        nil
      end

      # Load a blob: document (bytes from the opener) as THIS window's top-level
      # document — for `window.open(blobURL)` / a blob: aux-window navigation,
      # where the blob isn't rack-navigable and lives in the opener's isolate.
      def boot_blob_document(url, bytes, content_type)
        @current_url = url.to_s
        ct = content_type.to_s.empty? ? 'text/html' : content_type.to_s
        # Blob string parts are UTF-8-encoded; when the Blob type carries no
        # charset, decode the document as UTF-8 (not the windows-1252 HTML locale
        # default, which is an HTTP concept that doesn't apply to in-memory blobs —
        # matches the iframe blob: path's decodeBlobBody). A charset in the Blob
        # type (url-charset) is preserved so it can override <meta charset>.
        ct = "#{ct};charset=utf-8" unless ct.downcase.include?('charset')
        record_response(200, {'content-type' => ct})
        b64 = Base64.strict_encode64(bytes.to_s.b)
        # Make the blob URL fetchable from the document we're about to load — a blob:
        # document that fetches itself (or a media `src` first-party load) snapshots
        # the bytes SYNCHRONOUSLY at fetch() time, which runs DURING boot below, so the
        # bytes must be registered in this window's @blob_registry FIRST. No partition
        # entry — the blob keeps its original storage partition; this only makes it
        # first-party-fetchable in the window it was navigated into.
        @blob_registry_lock.synchronize { @blob_registry[url.to_s] = b64 }
        boot_response_into_ctx(bytes)
        # Adopt into the in-VM store too, so a LATER resolve keeps the correct content
        # type (the @blob_registry b64 path resolves as application/octet-stream).
        @runtime.call('__csimAdoptBlobBytes', url.to_s, b64, content_type.to_s) rescue nil
      end

      # A user-initiated `URL.revokeObjectURL`. Storage-partitioned + cross-isolate:
      # the Driver vetoes a cross-partition revoke (a same-origin but cross-top-level-
      # site context can't revoke the blob — cross-partition.https) and, for a
      # same-partition revoke, invalidates the blob in the CREATOR's isolate too so
      # every window stops resolving it (the blob may have been created in another
      # window). (Context-teardown revokes go through revoke_owned_blobs, not here.)
      def blob_unregister(url)
        if @driver.respond_to?(:revoke_blob_partitioned)
          return nil unless @driver.revoke_blob_partitioned(url.to_s, self)
        elsif @driver.respond_to?(:unregister_blob_partition)
          @driver.unregister_blob_partition(url.to_s)
        end
        drop_local_blob(url)
        nil
      end

      # Forget a blob URL in THIS isolate: its validity marker / bytes in
      # @blob_registry and its in-VM store entry. Called for a local revoke and, via
      # the Driver, when another same-partition window revokes a blob this isolate
      # created. The @blob_registry removal is the AUTHORITATIVE invalidation
      # (resolveBlobBytes gates on it cross-realm); the in-VM `__csimDropBlob` is a
      # same-thread V8 call, so it's skipped on a worker thread — a worker's
      # `revokeObjectURL` forwards here on the WORKER thread, and calling a
      # thread-confined isolate from a non-owning thread SEGVs (V8/quickjs isolates
      # are thread-bound). The stale in-VM entry is harmless: resolveBlobBytes returns
      # null once the registry marker is gone.
      def drop_local_blob(url)
        @blob_registry_lock.synchronize { @blob_registry.delete(url.to_s); @blob_owners.delete(url.to_s) }
        return if Thread.current[:csim_worker_handle]   # worker thread: the registry removal above is enough
        @runtime.call('__csimDropBlob', url.to_s) rescue nil
      end

      # Revoke every blob URL owned by a context that's going away (its blob URL
      # store is part of the global being torn down).
      def revoke_owned_blobs(key)
        revoked = @blob_registry_lock.synchronize do
          urls = @blob_owners.select {|_url, owner| owner == key }.keys
          urls.each {|url| @blob_registry.delete(url); @blob_owners.delete(url) }
          urls
        end
        if @driver.respond_to?(:unregister_blob_partition)
          revoked.each {|url| @driver.unregister_blob_partition(url) }
        end
      end
      # Keys are normalized with `.to_i` on BOTH sides (register tags
      # "r:#{owner_realm.to_i}") so a marshalled Float/String id still matches.
      def revoke_worker_blobs(handle) = revoke_owned_blobs("w:#{handle.to_i}")
      def revoke_realm_blobs(realm_id) = revoke_owned_blobs("r:#{realm_id.to_i}")

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

      # Wraps the raw bytes in whatever binary shape the ACTIVE runtime can
      # marshal to a JS Uint8Array (V8: the BINARY-tagged string itself —
      # tag-driven marshalling crosses it as a Uint8Array; QuickJS: base64
      # that the JS shim's `fetchedToBytes` atob's — it has no binary
      # marshaller). Asked of the runtime so each engine picks its shape.
      def transfer_buffer_fetch_for_js(id)
        bytes = transfer_buffer_fetch(id)
        return nil unless bytes
        @runtime.wrap_binary(bytes)
      end

      # ── Video decode (ffprobe + ffmpeg) ────────────────────────────
      #
      # Called from the JS bridge when a `<video>` element's `src` is
      # assigned a `blob:` URL. ffprobe extracts dimensions + duration,
      # ffmpeg extracts the first frame as raw RGBA. JS caches both so
      # `canvas.drawImage(video, …)` blits like any ImageBitmap. A `<video src>` that
      # points at a served file (http / relative) or a `data:` URL resolves its bytes
      # the same way — see `video_bytes_b64` below.
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

      # Fetch a media resource (http / relative URL) and return its bytes base64-encoded,
      # so a `<video src>` pointing at a served file decodes the same way a blob: / data:
      # source does. Binary stays Ruby-side; only ASCII base64 crosses into V8. Returns
      # nil when the fetch fails.
      def video_bytes_b64(url)
        result = rack_fetch('GET', url, '', {}, 'follow')
        return nil unless result && result['status'].to_i < 400
        # The RAW bytes ride `body_b64` (see response_hash) for any non-ASCII response;
        # the text `body` field is a UTF-8 re-decode that corrupts binary media. Fall
        # back to base64-of-body only for a pure-ASCII response (byte-identical there).
        b64 = result['body_b64']
        return b64 unless b64.nil? || b64.empty?
        body = result['body'].to_s
        body.empty? ? nil : [body].pack('m0')
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

      # The canonical MIME for each format we actually encode. An unsupported
      # request type maps to '.png' below, so the encoded format (and the type
      # we report back to the canvas) is image/png — matching the toBlob /
      # toDataURL "unsupported type falls back to image/png" rule.
      EXT_TO_MIME = {
        '.jpg'  => 'image/jpeg',
        '.webp' => 'image/webp',
        '.png'  => 'image/png'
      }.freeze
      private_constant :EXT_TO_MIME

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
          {'refId' => transfer_buffer_stash(img.write_to_buffer(ext, **opts)), 'mime' => EXT_TO_MIME[ext]}
        }
      end

      def webauthn = (@webauthn ||= WebauthnState.new)

      # Worker thread entry. Builds an isolate via the engine class's
      # `build_worker` factory, evaluates the worker script, then
      # loops draining microtasks + timers + inbox until `:terminate`
      # lands or an exception propagates.
      private def run_worker(handle, url, body, inbox, outbox, engine_class, shared: false, service: false, creator_key: nil)
        # Release the spawn-time `@worker_initializing` count exactly once, however
        # this method exits (normal start, `self.close()`, or an exception), so
        # worker_pending? doesn't stay stuck true forever.
        initializing = true
        release_init = lambda do
          next unless initializing
          initializing = false
          @worker_init_lock.synchronize { @worker_initializing -= 1 }
        end
        # Tag this thread so blob URLs created by the worker's script are owned by
        # this handle and revoked on terminate (see blob_register / revoke_worker_blobs).
        Thread.current[:csim_worker_handle] = handle
        rt = nil
        raise "worker script not found: #{url}" unless body
        # The worker SCRIPT is text; the Rack-fetched body arrives
        # BINARY-tagged (see `RuntimeShared.utf8_text`).
        body = RuntimeShared.utf8_text(body)
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
        sw_hooks = {
          post_to_client: ->(client_id, data) { outbox << {handle: handle, kind: 'sw_client_msg', client: client_id, data: data.to_s} },
          claim:          ->                  { outbox << {handle: handle, kind: 'sw_claim', has_fetch: sw_has_fetch} },
          fetch_respond:  ->(fetch_id, resp, realm_id) { sw_deliver_fetch_response(handle, fetch_id.to_i, resp.to_s, outbox, realm_id.to_i) },
          # A streaming respondWith frame (start / chunk / close / error) for a controlled client's
          # fetch — rides the outbox in emission order so the client realm reassembles the body
          # stream incrementally (deliver_worker_messages). The request's @sw_fetch_pending stays up
          # for the whole stream and clears on the terminal (close / error) frame.
          fetch_stream:   ->(fetch_id, kind, payload, realm_id) { outbox << {handle: handle, kind: "fr_#{kind}", fetch_id: fetch_id.to_i, payload: payload.to_s, realm_id: realm_id.to_i} },
          # Cross-isolate MessagePort channel: this worker's port endpoint + its outbound messages
          # ride the outbox (delivered by deliver_worker_messages → the peer client realm).
          port_endpoint:  ->(channel)       { outbox << {handle: handle, kind: 'port_endpoint', channel: channel.to_s} },
          port_post:      ->(channel, data) { outbox << {handle: handle, kind: 'port_msg', channel: channel.to_s, data: data.to_s} }
        }
        rt        = engine_class.build_worker(self, post_back, broadcast_out, sw_hooks)
        # This worker's handle — the JS keys cross-isolate MessagePort channel ids on it so they
        # never collide with another isolate's (see __csim_installWorkerScope's allocator).
        rt.eval("globalThis.__csimWorkerHandle = #{handle.to_i};")
        # Set the worker's `self.location.href` so webpack /
        # rollup public-path derivation + `new URL(rel, import.meta.url)`
        # resolve chunks against the worker's own origin rather than
        # the snapshot-time `http://placeholder/`.
        rt.eval("globalThis.__csimUpdateLocation(#{JSON.generate(url.to_s)});")
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
        rt.eval("globalThis.__csimOriginKey = #{JSON.generate(worker_origin_key)};") if worker_origin_key
        # A service worker runs in a ServiceWorkerGlobalScope: adjust the worker scope
        # (no blob-URL minting; SW lifecycle stubs) BEFORE its script runs.
        rt.eval('__csim_installServiceWorkerScope();') if service
        rt.eval(body)
        rt.drain_microtasks
        # Drive the service worker's lifecycle: fire `install`, then `activate`, draining each
        # phase's `waitUntil` promises before the next (the client-side ServiceWorker object plays
        # out the observable installing→installed→activating→activated timeline; here we run the
        # worker's OWN install/activate handlers so their side effects — caching, importScripts —
        # execute). See sw-client.js + __csim_swFireLifecycleEvent.
        if service
          sw_has_fetch = !!rt.call('__csim_swHasFetchListener')
          # Publish the fetch-handler snapshot + script URL on the worker record so a NAVIGATION
          # into this SW's scope can decide (Ruby-side) whether routing through it is worthwhile,
          # and a freshly-built frame client can mint a `controller` naming this script.
          if (w = @workers[handle])
            w[:has_fetch]  = sw_has_fetch
            w[:script_url] = url.to_s
          end
          %w[install activate].each do |phase|
            rt.eval("globalThis.__csim_swFireLifecycleEvent(#{JSON.generate(phase)});")
            # Drain microtasks AND timers: a `waitUntil` promise may settle off a
            # setTimeout (e.g. a delayed cache warm-up), so advance the worker clock too.
            rt.drain_microtasks
            rt.drain_timers
          end
        end
        # A SharedWorker fires `connect` AFTER its script set `self.onconnect`; the
        # connect handler's port post lands in the outbox before release_init, so
        # worker_pending? stays true until it's delivered.
        if shared
          rt.eval('typeof __csimFireSharedWorkerConnect === "function" && __csimFireSharedWorkerConnect();')
          rt.drain_microtasks
        end
        # Initial script has run (and any immediate postMessage is in the outbox).
        release_init.call
        # A worker that called `self.close()` in its top-level script stops here —
        # the script ran (and may have posted), but no further messages are pulled.
        unless rt.call('__csimWorkerClosedRead')
          loop do
            msg = pop_with_timeout(inbox, WORKER_POLL_INTERVAL)
            break if msg == :terminate
            # A main-side BroadcastChannel post to this worker arrives as a {kind:'broadcast'} hash;
            # deliver it to the worker's channels (the receiver's own origin gate drops cross-origin).
            # A plain string is a postMessage to the worker.
            if msg.is_a?(Hash) && msg[:kind] == 'broadcast'
              # Ack so the main thread releases the broadcast-pending it counted for this delivery
              # (a listen-only worker never posts back — the ack is the only signal it processed
              # it). Under `ensure`: the ack is CONTRACTUAL (settle's bounded wait relies on it —
              # see worker_reply_pending?), so a raising channel handler must not leak it.
              begin
                rt.call('__csim_deliverBroadcasts', [{'name' => msg[:name], 'data' => msg[:data], 'origin' => msg[:origin]}])
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
              ensure
                outbox << {handle: handle, kind: 'swack'}
              end
            elsif msg.is_a?(Hash) && msg[:kind] == 'port_msg'
              # A client-realm port → its remote peer in THIS worker: deliver to the channel endpoint
              # port. Counted like an sw_message (client_port_post incremented @sw_message_pending), so
              # ack AFTER dispatch under `ensure` — a synchronous reply the port handler posts back
              # (another port_msg on the outbox) is FIFO-guaranteed to precede this swack.
              begin
                rt.call('__csimPortChannelDeliver', msg[:channel], msg[:data])
              ensure
                outbox << {handle: handle, kind: 'swack'}
              end
            elsif msg.is_a?(Hash) && msg[:kind] == 'client_register'
              # A controlled client (frame/window realm) came into existence: mirror it into the
              # SW's clientsById so matchAll/getClientByURL see it. Fire-and-forget (no reply /
              # pending counter): the inbox is FIFO, so it's processed before any later message
              # whose handler matchAll's the client.
              rt.call('__csim_swRegisterClient', msg[:client])
            elsif msg.is_a?(Hash) && msg[:kind] == 'client_unregister'
              # The client's realm was disposed — drop it so matchAll stops returning a dead client.
              rt.call('__csim_swUnregisterClient', msg[:id])
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
            elsif msg
              rt.call('__csim_workerOnMessage', msg)
            end
            # Drive the worker's OWN event loop each tick: a message handler OR an
            # AUTONOMOUS loop (the dispatcher executor-worker's receive→fetch→setTimeout
            # retry, which has no inbox message) may have pending timers. Drain ~one poll
            # interval (WorkerRuntime#drain_timers advances the worker clock a step) so
            # they progress; worker http fetch is setTimeout(0)+__rackFetch, resolved on
            # this thread by the drain. Gated on a PENDING timer (any, not just due-now —
            # the clock must advance to fire a future randomDelay) so an idle
            # message-driven worker with no timers stays lazy. Host CALLS, not string
            # `eval`, keep the per-tick cost off the V8 compile path (rule 3).
            if rt.call('__nextTimerDelay').to_f >= 0
              rt.drain_microtasks
              rt.drain_timers
            end
            break if rt.call('__csimWorkerClosedRead')
          end
        end
      rescue StandardError => e
        outbox << {handle: handle, kind: '__error', message: "#{e.class}: #{e.message}"}
      ensure
        release_init.call   # guarantee the init count is released on an early raise
        rt&.dispose
      end

      # Bundlers that ship a worker inline as a Blob (Tesseract,
      # Webpack `?worker` imports, Vite worker chunks) construct
      # `new Worker(blobURL)`. Rack can't parse `blob:` so short-
      # circuit to the JS-side blob registry instead. Http(s) URLs
      # fall through to the regular Rack path.
      private def fetch_worker_script(url)
        u = url.to_s
        if u.start_with?('blob:')
          # Resolve via the Driver's partition store so a SAME-partition blob created
          # in ANOTHER window/isolate (the cross-partition-worker-creation test creates
          # the blob in the opener and the worker in a same-site iframe) is readable.
          # Falls back to this realm's own store when there's no Driver entry.
          if @driver.respond_to?(:blob_bytes_for) && (data = @driver.blob_bytes_for(u, self))
            return data[:bytes]
          end
          b64 = @runtime.call('__csimReadBlobBase64', u)
          # A blob created INSIDE a frame realm lives in that realm's in-VM store, which the main
          # runtime's `__csimReadBlobBase64` above can't see. But createObjectURL also registered its
          # bytes in the cross-realm `@blob_registry` (crossCtx, since a frame realm is multi-realm),
          # so fall back to it — this is what makes `new Worker(blobURL)` work from a data: iframe.
          b64 = blob_resolve(u) if b64.nil? || b64.to_s.empty?
          return nil if b64.nil? || b64.to_s.empty?
          return Base64.decode64(b64.to_s)
        end
        # `data:[<mediatype>][;base64],<data>` worker scripts (a worker created
        # from a data: URL — its origin is opaque, so its blob: URLs serialize
        # with a 'null' origin). Decode inline; Rack can't serve a data: URL.
        return decode_data_url_body(u) if u.start_with?('data:')
        rack_fetch_body(u)
      end

      # The decoded body of a `data:[<mediatype>][;base64],<data>` URL (RFC 2397):
      # base64-decoded when the `;base64` flag is present, else percent-decoded.
      private def decode_data_url_body(url)
        comma = url.index(',')
        return '' unless comma
        meta    = url[5...comma]
        payload = url[(comma + 1)..]
        if meta =~ /;base64\s*\z/i
          Base64.decode64(payload)
        else
          CGI.unescape(payload)
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

      # Fetch caps a request at 20 redirects: the 21st is a network error (redirect-count).
      # The loop below runs one iteration PER dispatch, so it needs 20 redirect hops plus
      # the final response — MAX_FETCH_REDIRECTS + 1 iterations — to let exactly 20 succeed.
      MAX_FETCH_REDIRECTS = 20
      # Request cache modes that never READ the store (always hit the network), and modes that
      # serve a STORED response even when stale. Frozen so the hot rack_fetch path allocates no
      # throwaway arrays per hop (perf).
      CACHE_MODES_SKIP_READ  = %w[no-store reload].freeze
      CACHE_MODES_SERVE_STALE = %w[force-cache only-if-cached].freeze
      # Fetch "bad port" blocklist (https://fetch.spec.whatwg.org/#port-blocking) —
      # ports tied to non-HTTP protocols a request must never reach. Frozen Set for
      # O(1) membership on the rack_fetch path.
      BAD_PORTS = Set[
        0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
        79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
        137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
        532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
        1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
        6669, 6679, 6697, 10080
      ].freeze

      REFERRER_POLICIES = %w[
        no-referrer no-referrer-when-downgrade origin origin-when-cross-origin
        same-origin strict-origin strict-origin-when-cross-origin unsafe-url
      ].freeze

      # The `Referer` value a request carries under a Referrer-Policy — nil = send none
      # (https://w3c.github.io/webappsec-referrer-policy/#determine-requests-referrer).
      # `referrer_url` is the request's referrer (the initiating document); `target_url`
      # its destination. "full" is the referrer stripped of fragment + credentials;
      # "origin" is scheme://host[:port]/. An empty / unknown policy → the default
      # (strict-origin-when-cross-origin).
      def compute_referrer(policy, referrer_url, target_url)
        return nil if referrer_url.nil? || referrer_url.to_s.empty?
        policy = 'strict-origin-when-cross-origin' unless REFERRER_POLICIES.include?(policy)
        return nil if policy == 'no-referrer'
        # The referrer is almost always the (constant) document URL — memoise its parse
        # so the rack_fetch hot path doesn't re-parse it per request (rule 3).
        ref = parse_referrer_url(referrer_url)
        return nil unless ref && %w[http https].include?(ref.scheme)
        full        = -> { u = ref.dup; u.fragment = nil; u.password = nil; u.user = nil; u.to_s }
        origin_only = -> {
          default_port = ref.scheme == 'https' ? 443 : 80
          port         = ref.port && ref.port != default_port ? ":#{ref.port}" : ''
          "#{ref.scheme}://#{ref.host}#{port}/"
        }
        return full.call        if policy == 'unsafe-url'
        return origin_only.call if policy == 'origin'
        # The remaining policies need the target to know same-origin / downgrade.
        tgt = (URI.parse(target_url) rescue nil)
        return nil unless tgt
        same_origin = ref.scheme == tgt.scheme && ref.host == tgt.host && ref.port == tgt.port
        downgrade   = ref.scheme == 'https' && tgt.scheme == 'http'
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
        @referrer_parsed     = (URI.parse(url) rescue nil)
      end

      # Whether a request to `url_str` must be blocked as a Fetch "bad port". Cheap
      # pre-gate: only URLs whose authority carries an explicit `:<digit>` are parsed
      # (the vast majority don't), so the rack_fetch hot path — every asset / xhr /
      # fetch, cache hits included — skips URI.parse entirely.
      def bad_port?(url_str)
        return false unless url_str =~ %r{\A[a-z]+://[^/]*:\d}i
        port = URI.parse(url_str).port
        port && BAD_PORTS.include?(port)
      rescue URI::Error
        false
      end

      # URLs we won't even try to route through Rack: anything that
      # isn't http(s) (data: / mailto: / about:) plus pseudo-tokens
      # like V8's `<snapshot>` that sourcemap libraries pull out of
      # error stacks and feed straight to `fetch()` / `xhr.open()`.
      def rack_fetch(method, url, body, headers, redirect_mode, cors_mode = nil, credentials: 'same-origin', env_extras: nil, referrer_policy: nil, referrer: nil, cache_mode: 'default')
        # NB: a relative fetch/XHR URL is resolved against the document's API base URL
        # at OPEN time (XHR open() / fetch()), in JS, NOT here — resolving at send time
        # would wrongly pick up a `<base href>` inserted after open() (open-url-base
        # -inserted-after-open). So this resolves only against the document URL.
        target = resolve_against_current(url.to_s)
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
        # The request's origin (document origin) for EVERY fetch mode — Fetch appends an
        # Origin header to every non-GET/HEAD request regardless of mode (a same-origin or
        # no-cors POST/PUT still carries it, for the server's CSRF/Origin check). CORS
        # enforcement itself stays gated on `cors` below; a nil-mode internal caller
        # (navigation / asset GET) has no origin semantics.
        req_origin  = %w[cors no-cors same-origin].include?(cors_mode) ? url_origin(@current_url) : nil
        # Fetch request "mode" (fetch threads it; XHR is always 'cors'; a non-fetch/xhr
        # caller passes nil → no mode semantics, a plain 'basic' response). `no-cors`
        # filters a cross-origin response to opaque; `same-origin` makes a cross-origin
        # request a network error. `doc_origin` detects cross-origin for the response
        # TYPE regardless of whether CORS enforcement (cors) runs; `crossed` latches once
        # any hop leaves the document origin.
        no_cors_mode     = cors_mode == 'no-cors'
        same_origin_mode = cors_mode == 'same-origin'
        # Only the real fetch request modes carry cross-origin semantics; a 'navigate'
        # (form submission) or a nil-mode internal caller gets a plain readable response.
        doc_origin       = %w[cors no-cors same-origin].include?(cors_mode) ? url_origin(@current_url) : nil
        crossed          = false
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
        # JS-side base64-encodes Blob/File bodies (raw bytes survive
        # the engine's UTF-8 string boundary that way); decode before
        # handing to Rack so the upload PUT lands intact.
        if headers.is_a?(Hash) && headers['X-Csim-Body-B64'].to_s == '1'
          body = Base64.decode64(body.to_s)
          headers = headers.reject {|k, _| k == 'X-Csim-Body-B64' }
        end
        # The request's origin starts as the document origin; a cross-origin REDIRECT
        # taints it to an opaque origin (serialized "null") per Fetch "HTTP-redirect
        # fetch". `effective_origin` IS that origin — it's what the Origin header
        # carries and what the CORS check / preflight compare against from that hop on
        # ('null' once tainted, so the server must then allow 'null' or '*').
        effective_origin = req_origin
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
        ref_source = referrer.nil? ? @current_url : referrer
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
                return response_hash(0, {}, '', target, false, type: 'opaqueredirect', body_null: true)
              end
              if (loc = redirect_location(cache_entry.status, cache_entry.headers))
                trace_network(method, target, cache_entry.status, headers, body, cache_entry.headers, nil, t0, true)
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
            return response_hash(cache_entry.status, cache_entry.headers, cache_entry.body, target, redirected)
          end
          # only-if-cached forbids the network: no usable stored response → a network error.
          return nil if cache_mode == 'only-if-cached'

          env = Rack::MockRequest.env_for(target, method: method, input: body || '')
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
          env.merge!(env_extras) if env_extras
          status, resp_headers, resp_body = dispatch_rack_or_http(target, env, method: method, body: body)
          # Fetch credentials mode "omit" ignores credentials the response sends back too —
          # its Set-Cookie is dropped, not stored (cors-cookies / credentials "omit mode").
          merge_set_cookie(resp_headers, target) unless credentials == 'omit'
          if status == 304 && cache_entry
            trace_network(method, target, cache_entry.status, headers, body, cache_entry.headers, nil, t0, false)
            resp_body.close if resp_body.respond_to?(:close)
            @@asset_cache.refresh(cache_entry, resp_headers)
            # The cache stores the RAW response headers, so a cross-origin cached entry must
            # be re-filtered through the CORS exposed-header set on the way back to script —
            # a 304 revalidation must not leak headers the original cross-origin fetch hid.
            cached_headers = cross_origin ? cors_exposed_headers(cache_entry.headers, with_credentials) : cache_entry.headers
            return response_hash(cache_entry.status, cached_headers, cache_entry.body, target, redirected)
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
            resp_body.close if resp_body.respond_to?(:close)
            raise StandardError, '[capybara-simulated] fetch: redirect blocked by redirect=error mode' if redirect_mode == 'error'
            # A no-cors request may not even opaquely expose a CROSS-origin redirect — a
            # no-cors non-follow redirect to a cross-origin target is a network error,
            # while a same-origin one still yields an opaque-redirect.
            return nil if no_cors_mode && crossed
            return response_hash(0, {}, '', target, false, type: 'opaqueredirect', body_null: true)
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
            if (rp = resp_headers['referrer-policy'] || resp_headers['Referrer-Policy'])
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
            if ([301, 302].include?(status) && up == 'POST') || (status == 303 && !%w[GET HEAD].include?(up))
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
            raw_loc = resp_headers['location'] || resp_headers['Location']
            raw_loc = raw_loc.first if raw_loc.is_a?(Array)
            if raw_loc && raw_loc.to_s.empty?
              resp_body.close if resp_body.respond_to?(:close)
              return nil
            end
          end
          body_str = read_rack_body(resp_body)
          # A HEAD response, and a null-body status (204/205/304), have NO body — the UA
          # discards whatever the server sent and exposes response.body as null
          # (response-method HEAD; response-null-body). `null_body` flags it so the JS
          # Response reports a null body + empty text.
          null_body = method.to_s.upcase == 'HEAD' || NULL_BODY_STATUSES.include?(status.to_i)
          body_str = '' if null_body
          # The UA transparently decodes a Content-Encoding'd body (gzip/deflate); the
          # header stays, the bytes are inflated (response-data-gzip / -deflate).
          body_str = decode_content_encoding(body_str, resp_headers)
          # A cross-origin response only EXPOSES (getResponseHeader / getAllResponseHeaders)
          # the CORS-safelisted response headers plus those named in Access-Control-Expose
          # -Headers (`*` = all). content-type stays safelisted, so response decoding is
          # unaffected. (Filtered for script exposure only — trace / set-cookie / cache see
          # the full set.) The CORS check itself already ran above (incl. on 3xx hops).
          exposed_headers = cross_origin ? cors_exposed_headers(resp_headers, with_credentials) : resp_headers
          trace_network(method, target, status, headers, body, resp_headers, body_str, t0, false)
          # A no-store request must not write the cache (RFC 9111 §5.2.1.5); a request carrying
          # the author's own conditional bypasses the UA cache entirely (read AND write) — it's
          # "treated similarly to no-store" (request-cache-default-conditional). Every other mode
          # (incl. reload, which refreshes it) stores a cacheable GET response.
          @@asset_cache.store(target, status, resp_headers, body_str) if method == 'GET' && cache_mode != 'no-store' && !skip_cache
          # A no-cors cross-origin response is OPAQUE: status 0, empty body, no exposed
          # headers, empty URL (cors-basic "Opaque filter"). Otherwise the type is 'cors'
          # for a cross-origin (CORS-allowed) response, else 'basic'.
          return response_hash(0, {}, '', '', false, type: 'opaque', body_null: true) if no_cors_mode && crossed
          return response_hash(status, exposed_headers, body_str, target, redirected, type: crossed ? 'cors' : 'basic', body_null: null_body)
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
        ct = resp_headers && (resp_headers['content-type'] || resp_headers['Content-Type'])
        ct = ct.first if ct.is_a?(Array)  # Rack 3 permits array-valued header fields
        ct = ct.split(';', 2).first&.strip if ct.is_a?(String)   # "" → split is [] → first is nil
        size = if resp_body
                 resp_body.bytesize
               elsif (cl = resp_headers && (resp_headers['content-length'] || resp_headers['Content-Length']))
                 (cl.is_a?(Array) ? cl.first : cl).to_i
               end
        log_network(method, url, status,
                    content_type:     (ct if ct.is_a?(String)),
                    size:             size,
                    duration_ms:      (t0 && ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0) * 1000).round),
                    redirected:       (redirected || nil),
                    request_headers:  normalize_trace_headers(req_headers),
                    request_body:     (req_body && !req_body.to_s.empty? ? cap_trace_body(req_body) : nil),
                    response_headers: normalize_trace_headers(resp_headers),
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

      def normalize_trace_headers(headers)
        return nil unless headers
        headers.each_with_object({}) do |(k, v), out|
          # `x-csim-status-text` is an internal sentinel carrying the HTTP reason
          # phrase (response_hash lifts it into statusText); it's never a real wire
          # header, so keep it out of the trace.
          next if k.to_s.downcase == 'x-csim-status-text'
          out[k.to_s] = v.is_a?(Array) ? v.join(', ') : v.to_s
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

      # Content types whose bytes are already representable in the
      # UTF-8 string that ships back to JS — base64 wouldn't add
      # anything and `Base64.strict_encode64` is ~1 % of suite wall
      # time on Discourse. Binary types (images, octet-stream,
      # gzipped traineddata, etc.) still need `body_b64` because V8 /
      # QuickJS mangle bytes 0x80-0xFF over the UTF-8 string boundary.
      # `fetch.js#_decodeBytes` and `xhr.js` both fall back to the
      # text body when `body_b64` is absent.
      TEXT_CONTENT_TYPE_PREFIXES = %w[text/ application/json application/javascript application/ecmascript application/xml image/svg+xml].freeze

      def response_hash(status, headers, body, url, redirected, type: 'basic', body_null: false)
        raw     = body.to_s
        hdrs    = stringify(headers)
        # A NUL in a header value is not a valid HTTP message; a real server can't
        # put it on the wire, so the fetch is a network error (nil → status 0 / a
        # thrown NetworkError for a sync XHR). See headers-normalize-response.
        return nil if hdrs.any? {|_, v| v.include?("\u0000") }
        is_text = text_response?(hdrs)
        # `body` crosses as TEXT — `responseText` semantics: the bytes decoded
        # as UTF-8 with invalid sequences replaced (a leading BOM selects the
        # encoding per the HTML "decode" algorithm and is removed). The real
        # bytes for binary consumers ride `body_b64`; the Rack body arrives
        # BINARY-tagged (see `RuntimeShared.utf8_text`).
        bom_charset = nil
        text =
          if is_text
            decoded, bom_charset = decode_response_bom(raw)
            RuntimeShared.utf8_text(decoded)
          else
            RuntimeShared.utf8_text(raw)
          end
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
        out = {
          'status'     => status,
          'statusText' => reason,
          'headers'    => hdrs,
          'body'       => text,
          'url'        => url,
          'redirected' => redirected,
          'type'       => type
        }
        out['body_null'] = true if body_null   # null-body status / HEAD → response.body is null
        # The BOM-detected encoding (if any) — a frame load pins its document's
        # characterSet to it (see __csimFrameWindow); highest-precedence signal.
        out['charset']  = bom_charset if bom_charset
        # Hand the raw bytes to the (XHR) client UNLESS the response is pure-ASCII text.
        # ASCII decodes identically under every encoding — so responseText is already
        # correct from the UTF-8 `body`, and it round-trips byte-for-byte as an
        # ArrayBuffer/Blob. Any NON-ASCII body needs the bytes: a non-UTF-8 charset or an
        # XML-prolog / <meta charset>-sniffed encoding (responseText), or multibyte UTF-8
        # read as arraybuffer/blob — the client decodes them with the final encoding
        # (decodeResponseBytes). `ascii_only?` is a cheap C-level scan, so the dominant
        # pure-ASCII app JSON/HTML traffic keeps the fast path and pays no base64.
        out['body_b64'] = Base64.strict_encode64(raw) unless is_text && raw.ascii_only?
        out
      end

      # Strip + decode a single leading byte-order mark, returning
      # `[utf8_text, charset]` — `charset` is the BOM-selected Encoding-standard
      # name (highest-precedence encoding signal) or nil when there's no BOM (the
      # hot path: just a 2–3 byte prefix check). One BOM is consumed; any further
      # BOMs are ordinary U+FEFF characters in the decoded text (per spec the
      # parser does not strip them again).
      # An XML-family document (XHTML / SVG / application+text/xml). Its encoding
      # default is UTF-8 — the windows-1252 locale default is HTML-only.
      def xml_content_type?(content_type)
        mime = content_type.to_s.split(';', 2).first.to_s.strip.downcase
        mime.end_with?('+xml') || mime == 'application/xml' || mime == 'text/xml'
      end

      # Does the response carry an explicit encoding signal (so the default
      # windows-1252 decode must NOT apply)? A `charset=` in the Content-Type, or
      # a `<meta charset>` / `<meta http-equiv=content-type … charset=…>` in the
      # HTML prescan window (the first 1024 bytes, per the HTML sniffing algorithm).
      # The `charset` must start a real attribute / content-charset (preceded by
      # whitespace, a quote, or `;`), so hyphenated look-alikes — `data-charset=`,
      # `accept-charset=` — don't false-trigger the signal.
      def html_charset_signal?(content_type, raw)
        return true if /;\s*charset\s*=/i.match?(content_type.to_s)
        head = raw.to_s.b[0, 1024].to_s
        /<meta\b[^>]*[\s"';]charset\s*=/i.match?(head)
      end

      # Decode bytes as windows-1252 (the HTML locale-default encoding) to a UTF-8
      # Ruby string. Replaces undefined slots rather than raising.
      def decode_windows1252(s)
        s.to_s.b.dup.force_encoding(Encoding::WINDOWS_1252)
         .encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
      rescue StandardError
        RuntimeShared.utf8_text(s)
      end

      def decode_response_bom(s)
        b = s.b
        if b.start_with?("\xEF\xBB\xBF".b)
          [b.byteslice(3..).force_encoding(Encoding::UTF_8), 'UTF-8']
        elsif b.start_with?("\xFF\xFE".b) || b.start_with?("\xFE\xFF".b)
          # Generic UTF-16: the BOM picks endianness and is dropped by the decoder.
          # Replace malformed units rather than raising (a truncated/odd-length
          # body still yields readable UTF-8 instead of falling back to raw bytes).
          # A UTF-32LE BOM (FF FE 00 00) is matched here as UTF-16LE too — which is
          # exactly what browsers do (UTF-32 unsupported; the leading FF FE is read
          # as the UTF-16LE BOM).
          charset = b.start_with?("\xFF\xFE".b) ? 'UTF-16LE' : 'UTF-16BE'
          [b.force_encoding(Encoding::UTF_16).encode(Encoding::UTF_8, invalid: :replace, undef: :replace), charset]
        else
          [s, nil]
        end
      rescue StandardError
        [s, nil]
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
      # after the call returns. Same pattern as `__csimPendingFormSubmit`.
      def location_assign(url)
        @pending_location = resolve_against_current(url.to_s)
      end
      def consume_pending_location
        return unless (url = @pending_location)
        @pending_location = nil
        # A `location.href`/`assign`/`hash` set to a same-document
        # fragment (e.g. `location.hash = ''`) is NOT a document fetch —
        # move the hash without rebuilding the VM, matching the anchor-
        # click navigate branch. Without this a hash assignment reloaded
        # the page, discarding all JS state.
        if pure_fragment_navigation?(url)
          update_current_hash(url)
        elsif @current_realm_id
          # A JS-driven `location.*` from inside a `within_frame` block
          # navigates the FRAME, not the top page (same as a self-targeted
          # link/form there). Gated on the realm, so the main-page path is
          # untouched.
          navigate_frame(url)
        else
          navigate(url)
        end
      end
      # A nested browsing context navigating its OWN `location` (the frame's
      # `location.href`/assign/replace/`location=`, incl. cross-frame
      # `iframe.contentWindow.location.href = …`). `realm_id` is the frame's realm.
      # Deferred like location_assign: applying it re-navigates the owning iframe,
      # which disposes that realm — illegal while the frame's location setter is
      # still on the V8 stack — so we stash and drain from `tick_real_time`.
      def frame_navigate_self(url, realm_id)
        return if realm_id.nil? || realm_id.zero?
        # Keyed by realm id (last URL wins per frame) so two different frames each
        # navigating in one turn both apply — a single slot would drop one.
        (@pending_frame_nav ||= {})[realm_id] = url.to_s
      end
      def consume_pending_frame_nav
        # Window-realm self-navs are realm navs too — drain them at every frame-nav
        # drain point (before the frame-nav early-return so a window-only nav lands).
        consume_pending_window_nav
        return if @pending_frame_nav.nil? || @pending_frame_nav.empty?
        navs = @pending_frame_nav
        @pending_frame_nav = nil
        navs.each do |realm_id, url|
          invalidate_find_cache
          # If this frame is on the entered `within_frame` stack, navigate it
          # through `navigate_frame` — it does the full fetch (redirects /
          # downloads / cookies) AND updates `@frame_stack` / `@current_realm_id`
          # so the enclosing `within_frame` block sees the new document. Otherwise
          # (a parent's `iframe.contentWindow.location.href = …`) re-navigate the
          # owning iframe by realm id via the src-reassignment path. Top-level
          # frames live in the main document; a nested non-entered frame's element
          # is in its parent realm's DOM (not yet routed — documented gap).
          entry = @frame_stack.find {|e| e[:realm_id] == realm_id }
          if entry
            navigate_frame(url, entry: entry)
          else
            @runtime.call('__csimNavigateFrameByRealm', realm_id, url)
          end
        rescue StandardError => e
          log_console('warn', "frame self-navigation failed: #{e.message}")
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
          # The blob's bytes arrive BINARY-tagged (Base64-decoded). __csimLoadDocument
          # HTML-parses TEXT, and a BINARY string marshals to V8 as a Uint8Array (not a
          # String), which `String(...)`s to comma-joined digits — a script-less doc. Decode
          # to UTF-8 text like every other load path (see RuntimeShared.utf8_text).
          spec[:body]  = RuntimeShared.utf8_text(b[:bytes])
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
        @pending_reload = false
        refresh
      end
      # `frame.contentWindow.location.reload()` from a nested browsing context.
      # Like `frame_navigate_self`, the JS side flags the initiating realm here
      # and we defer (so the child realm isn't disposed mid-reload()). Keyed by
      # realm id so two frames reloading in one turn both apply.
      def frame_reload_self(realm_id)
        return if realm_id.nil? || realm_id.zero?
        (@pending_frame_reload ||= []) << realm_id
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
          # held path below reuses bytes via reloadFrame.) Otherwise (a parent's
          # `iframe.contentWindow.location.reload()`, empty href, or a realm torn
          # down between flag and drain) re-navigate the owning iframe by realm id
          # JS-side, reusing the retained content so blob bytes survive a revoke.
          entry = @frame_stack.find {|e| e[:realm_id] == realm_id }
          url   = entry && @runtime.frame_realm_alive?(realm_id) ? @runtime.realm_call(realm_id, '__csimLocationHref').to_s : ''
          cur   = current_frame_history_entry(realm_id)
          if entry && !url.empty?
            navigate_frame(url, entry: entry)
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
      # pending-submit slot lives on the initiating realm's globalThis, which no
      # top-page drain reads, so the JS side flags the realm here (mirrors
      # `frame_navigate_self`). Keyed by realm id; deferred + drained from
      # `drain_pending_navigation` so we never serialize/navigate while the
      # form's `submit()` is still on the V8 stack.
      def frame_submit_self(realm_id)
        return if realm_id.nil? || realm_id.zero?
        (@pending_frame_submit ||= []) << realm_id
      end
      def consume_pending_frame_submit
        return if @pending_frame_submit.nil? || @pending_frame_submit.empty?
        realm_ids = @pending_frame_submit.uniq
        @pending_frame_submit = nil
        realm_ids.each do |realm_id|
          next unless @runtime.frame_realm_alive?(realm_id)
          sub = @runtime.realm_call(realm_id, '__csimTakePendingFormSubmit')
          next unless sub.is_a?(Hash) && sub['formHandle']
          invalidate_find_cache
          submit_form_in_realm(realm_id, sub['formHandle'], sub['submitterHandle'], sub['entryList'])
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
        h[:entries][h[:idx]] = snapshot_outgoing_entry(realm_id, h[:entries][h[:idx]]) if h[:idx] >= 0
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
        if h[:idx] >= 0
          h[:entries][h[:idx]] = snapshot_outgoing_entry(realm_id, h[:entries][h[:idx]])
        else
          h[:entries] << frame_history_entry(realm_id)
          h[:idx] = 0
        end
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
      def frame_realm_url(realm_id)
        return nil unless @runtime.frame_realm_alive?(realm_id)
        @runtime.realm_call(realm_id, '__csimLocationHref').to_s
      rescue StandardError
        nil
      end
      def capture_frame_form_state(realm_id)
        return nil unless @runtime.frame_realm_alive?(realm_id)
        @runtime.realm_call(realm_id, '__csimCaptureFormState')
      rescue StandardError
        nil
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
        post_args = is_post ? {method: 'POST', body_b64: Base64.strict_encode64(body), content_type: entry[:content_type]} : {}
        # A history TRAVERSAL restores the entry's persisted form state (bfcache); a RELOAD gives a
        # fresh document, so it must NOT restore the (possibly stale) snapshot the entry was left with.
        restore = is_reload ? nil : entry[:form_state]
        # A traversal / reload is a navigation: route it through the controlling SW's fetch event
        # first — the refetch happens here, Ruby-side, bypassing the __csimFrameWindow interception
        # the initial load uses. A respondWith serves the document; a network error fails the
        # navigation; nil falls through to the network below.
        if (sw = service_worker_navigation_fetch(url, is_reload: is_reload, is_history: is_history, **post_args))
          return if sw['networkError']

          # Raw decoded bytes (like read_rack_body's byte-tagged output); reload_frame_realm_by_id
          # does the single utf8_text re-tag, matching the network path below.
          reload_frame_realm_by_id(realm_id, url, Base64.decode64(sw['body_b64'].to_s),
                                   response_content_type(sw['headers'] || {}), restore_state: restore)
          return
        end
        env = Rack::MockRequest.env_for(url, method: is_post ? 'POST' : 'GET', input: is_post ? body : '')
        if is_post
          env['CONTENT_TYPE']   = entry[:content_type].to_s.empty? ? 'application/x-www-form-urlencoded' : entry[:content_type]
          env['CONTENT_LENGTH'] = body.bytesize.to_s
        end
        apply_default_request_env(env, referer: current_browsing_context_url)
        status, headers, resp_body = dispatch_rack_or_http(url, env, method: is_post ? 'POST' : 'GET', body: is_post ? body : nil)
        merge_set_cookie(headers, url)
        return if download_response?(headers)
        html = read_rack_body(resp_body)
        reload_frame_realm_by_id(realm_id, url, html, response_content_type(headers), restore_state: restore)
      end
      # Serialize + route a form submitted inside frame realm `realm_id`. We
      # serialize in the INITIATING realm (so shadow-tree controls are excluded
      # and relative URLs resolve against that document), then route by target:
      #   - a NAMED frame within that context (a sibling iframe) — reassign its src;
      #   - self / _self / '' — navigate the initiating frame itself, same as a
      #     self-targeted link there (within_frame → navigate_frame; a frame
      #     reached via contentWindow → re-navigate its owning iframe by realm id).
      # GET fully supported. POST to a self frame needs the entered stack
      # (navigate_frame_post); POST-to-named and other targets from a nested
      # context aren't modeled (no in-scope need) — logged rather than dropped.
      def submit_form_in_realm(realm_id, form_handle, submitter_handle, entry_list = nil)
        spec = @runtime.realm_call(realm_id, '__csimFormSerialize', form_handle, submitter_handle || 0)
        return unless spec.is_a?(Hash)
        method = spec['method'].to_s.upcase
        method = 'GET' if method.empty?
        target = spec['target'].to_s
        action = spec['action'].to_s
        enctype = spec['enctype'].to_s.empty? ? 'application/x-www-form-urlencoded' : spec['enctype'].to_s.downcase
        entries = entry_list.is_a?(Array) ? entry_list : entries_from_spec(spec)
        # GET → urlencoded query (enctype ignored); POST → enctype-encoded body.
        get_query, = encode_entry_list(entries, 'application/x-www-form-urlencoded')
        get_url = form_get_url(action, get_query)
        if frame_self_target?(target)
          if method == 'GET'
            navigate_realm_self_get(realm_id, get_url)
          else
            body, content_type = encode_entry_list(entries, enctype)
            navigate_realm_self_post(realm_id, resolve_against_current(action), body, content_type)
          end
        elsif %w[_parent _top _blank].include?(target.downcase)
          log_console('warn', "nested-context form submit (target=#{target.inspect}) is not modeled")
        elsif method == 'GET'
          # Named sibling frame, GET. realm_call returns false when no frame of
          # that name exists in the initiating document (e.g. it lives in an
          # ancestor/top context, which HTML target resolution would reach but
          # we don't); surface it rather than dropping silently.
          found = @runtime.realm_call(realm_id, '__csimNavigateNamedFrame', target, get_url)
          log_console('warn', "nested-context form submit: no frame named #{target.inspect} in the submitting document") unless found
        else
          log_console('warn', "nested-context form submit (target=#{target.inspect}, method=POST) is not modeled")
        end
      end
      # HTML form-submission "mutate action URL" for GET: REPLACE the action
      # URL's query with the serialized entry list (dropping any pre-existing
      # query), preserving a trailing #fragment. String-based so it works on the
      # raw (possibly relative) action attribute without URI.parse fragility;
      # the absolute equivalent of submit_form_handle's `uri.query = body`. An
      # EMPTY entry list still clears the query (→ `action?`), matching browsers.
      def form_get_url(action, body)
        base, _hash, frag = action.partition('#')
        path = base.split('?', 2).first
        url  = "#{path}?#{body}"
        frag.empty? ? url : "#{url}##{frag}"
      end
      # A self-targeted GET form submit in the initiating frame realm: navigate
      # that frame to the action URL (query already mutated in).
      def navigate_realm_self_get(realm_id, get_url)
        record_frame_nav(realm_id, get_url)
        entry = @frame_stack.find {|e| e[:realm_id] == realm_id }
        if entry
          navigate_frame(resolve_against_current(get_url), entry: entry)
        else
          # A frame reached via contentWindow (not on the entered stack): its
          # owning iframe lives in its PARENT realm's document (the main realm for
          # a top-level frame, an intermediate realm for a nested one), so route
          # the by-realm src-reassignment there — not unconditionally to main.
          # (relative get_url resolves against the frame's base on rebuild).
          parent = @runtime.frame_realm_parent(realm_id)
          frame_realm_host_call(parent, '__csimNavigateFrameByRealm', realm_id, get_url)
        end
      end
      # A self-targeted POST form submit in the initiating frame realm. POST the
      # entity body to the action URL, then rebuild that frame's realm from the
      # response. An ENTERED frame (on @frame_stack) reuses navigate_frame_post;
      # a frame reached via contentWindow has no stack entry, so rebuild it by
      # realm id (recovering its container element + parent realm) and fire the
      # iframe element's load event the GET/src path would.
      def navigate_realm_self_post(realm_id, url, body, content_type, depth: 0, is_reload: false, is_history: false)
        raise 'too many redirects' if depth > 10
        # A reload / history traversal RE-POSTS an existing entry — it doesn't push a new one; only
        # a fresh submission records history. The POST method/body is tagged onto the entry AFTER a
        # DIRECT (non-redirect) response (tag_frame_entry_post below): a POST that redirects (the
        # Post/Redirect/Get pattern) resolves to a GET document, so its entry must NOT re-POST on a
        # later reload / back — only a directly-served POST does.
        record_frame_nav(realm_id, url) if depth.zero? && !is_reload && !is_history
        entry = @frame_stack.find {|e| e[:realm_id] == realm_id }
        return navigate_frame_post(url, body, content_type, entry: entry) if entry
        invalidate_find_cache
        # A controlled POST navigation goes to the SW's fetch event first (mode 'navigate', method
        # POST — the SW reads the body via event.request.text()); respondWith serves the document,
        # a network error fails it, nil falls through to the network POST below.
        if (sw = service_worker_navigation_fetch(url, method: 'POST', body_b64: Base64.strict_encode64(body.to_s), content_type: content_type, is_reload: is_reload, is_history: is_history))
          return if sw['networkError']

          tag_frame_entry_post(realm_id, body, content_type) if depth.zero?
          reload_frame_realm_by_id(realm_id, url.to_s, Base64.decode64(sw['body_b64'].to_s), response_content_type(sw['headers'] || {}))
          return
        end
        env = Rack::MockRequest.env_for(url, method: 'POST', input: body)
        env['CONTENT_TYPE']   = content_type.to_s.empty? ? 'application/x-www-form-urlencoded' : content_type
        env['CONTENT_LENGTH'] = body.bytesize.to_s
        apply_default_request_env(env, referer: current_browsing_context_url)
        status, headers, resp_body = dispatch_rack_or_http(url, env, method: 'POST', body: body)
        merge_set_cookie(headers, url)
        if (loc = redirect_location(status, headers))
          next_url = resolve_against_current(loc)
          resp_body.close if resp_body.respond_to?(:close)
          # 307/308 preserve method + body; 301/302/303 → GET the frame (routed
          # through the realm that OWNS the iframe, as in navigate_realm_self_get).
          if [307, 308].include?(status)
            return navigate_realm_self_post(realm_id, next_url, body, content_type, depth: depth + 1, is_reload: is_reload, is_history: is_history)
          end
          parent = @runtime.frame_realm_parent(realm_id)
          return frame_realm_host_call(parent, '__csimNavigateFrameByRealm', realm_id, next_url)
        end
        if download_response?(headers)
          save_downloaded_response(url, headers, resp_body)
          return
        end
        tag_frame_entry_post(realm_id, body, content_type) if depth.zero?
        reload_frame_realm_by_id(realm_id, url.to_s, read_rack_body(resp_body), response_content_type(headers))
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
      def reload_frame_realm_by_id(realm_id, url, html, content_type, restore_state: nil)
        parent = @runtime.frame_realm_parent(realm_id)
        handle = frame_container_handle(realm_id, parent)
        return if handle.zero?
        new_id = @runtime.reload_frame_realm(realm_id, parent.to_i, url, RuntimeShared.utf8_text(html), content_type).to_i
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
      def frame_realm_host_call(parent_realm_id, fn, *args)
        if parent_realm_id.nil? || parent_realm_id.zero?
          @runtime.call(fn, *args)
        else
          @runtime.realm_call(parent_realm_id, fn, *args)
        end
      end
      def drain_pending_navigation
        consume_pending_location
        consume_pending_frame_nav
        consume_pending_frame_submit
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
        @driver.open_aux_window(resolve_against_current(pending['url'].to_s, use_base: true),
                                source: self, blob_snapshot: pending['blob'])
      rescue StandardError => e
        log_console('warn', "aux-window open failed: #{e.message}")
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
      # The host a cookie is scoped to for `url`. RFC 6265 cookies are keyed by host
      # (not scheme/port), so cross-host requests never see each other's cookies while
      # a same-origin flow behaves exactly like a single jar. nil when the URL carries
      # no host (about:blank / data: / a relative current_url before the first navigate).
      def cookie_host(url)
        h = safe_uri(url.to_s)&.host
        h && !h.empty? ? h.downcase : nil
      end

      # The host cookies attach to for a request built into `env` — the target server
      # (SERVER_NAME / HTTP_HOST), NOT the current document, so a cross-origin fetch sends
      # the TARGET's cookies rather than leaking the document's (cors-cookies). Strips the
      # port while preserving an IPv6 bracket-literal (`[::1]`) so the key matches what
      # `cookie_host` derives from the URL via `URI#host`.
      def env_cookie_host(env)
        h = (env['HTTP_HOST'] || env['SERVER_NAME']).to_s
        h = h.start_with?('[') ? h[/\A\[[^\]]*\]/].to_s : h.split(':', 2).first
        h && !h.empty? ? h.downcase : nil
      end

      # The `Cookie` request-header value for a request to `host`: that host's jar,
      # serialized `name=value; …`. (Domain-attribute subdomain sharing isn't modelled —
      # the app suites are single-host; cross-host ISOLATION is what matters here.)
      #
      # TEXT, not binary: jar entries parsed out of Rack's Set-Cookie headers can carry the
      # BINARY tag, which would make the joined string cross into JS as a Uint8Array
      # (`document.cookie.match is not a function`). Cookies are ASCII per RFC 6265.
      def cookie_header_for(host)
        jar = host && @cookies[host]
        return '' if jar.nil? || jar.empty?
        RuntimeShared.utf8_text(jar.map {|k, v| "#{k}=#{v}" }.join('; '))
      end

      # `document.cookie` reads/writes the CURRENT document's host jar.
      def document_cookie_host
        cookie_host(current_browsing_context_url) || cookie_host(@default_host)
      end

      def document_cookie
        cookie_header_for(document_cookie_host)
      end
      def current_referer      ; @current_referer.to_s ; end
      def write_document_cookie(s)
        return if s.nil? || s.empty?
        host = document_cookie_host or return
        name, rest = s.split('=', 2)
        return if name.nil? || name.empty?
        parts = (rest || '').split(';').map(&:strip)
        value = parts.shift.to_s
        jar = (@cookies[host] ||= {})
        if cookie_deletion?(parts)
          jar.delete(name.strip)
        else
          jar[name.strip] = value
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

      # Cache Storage backing — origin-partitioned dumb store; the JS side owns the spec
      # matching (cache-storage.js). `@cache_storage` is
      #   origin => {seq:, names: {name => cache_id}, caches: {cache_id => {seq:, entries:}}}
      # The name→id indirection models the spec's "dooms, but does not delete immediately":
      # `caches.delete(name)` unmaps the name, but a Cache handle already bound to the id
      # keeps operating on its own storage (a fresh `open(name)` gets a new id / empty cache).
      # Each entry is `{id:, meta:, response:}` — `meta` the parsed request metadata the
      # matcher needs ({url, method, headers, vary}), `response` an opaque serialized-Response
      # JSON blob. Each host fn runs a single read-modify-write under the GVL, so concurrent
      # access from a service-worker thread stays atomic without a lock (localStorage
      # precedent). A doomed cache's storage lingers until `reset!` (per-test) frees it — a
      # bounded leak we accept rather than refcount handles across the JS boundary.
      def cache_storage_open(origin, name)
        store = (@cache_storage[origin.to_s] ||= {seq: 0, names: {}, caches: {}})
        id    = (store[:names][name.to_s] ||= (store[:seq] += 1))
        store[:caches][id] ||= {seq: 0, entries: []}
        id
      end
      def cache_storage_has(origin, name)
        @cache_storage.dig(origin.to_s, :names)&.key?(name.to_s) || false
      end
      def cache_storage_delete(origin, name)
        names = @cache_storage.dig(origin.to_s, :names) or return false
        !names.delete(name.to_s).nil?
      end
      def cache_storage_keys(origin)
        (@cache_storage.dig(origin.to_s, :names) || {}).keys
      end
      def cache_entries(origin, cache_id)
        cache = cache_for(origin, cache_id) or return nil
        JSON.generate(cache[:entries].map {|e| {id: e[:id]}.merge(e[:meta]) })
      end
      def cache_entry_response(origin, cache_id, entry_id)
        cache = cache_for(origin, cache_id) or return nil
        entry = cache[:entries].find {|e| e[:id] == entry_id.to_i } or return nil
        entry[:response]
      end
      def cache_put(origin, cache_id, delete_ids_json, meta_json, response_json)
        cache = cache_for(origin, cache_id) or return nil
        ids   = JSON.parse(delete_ids_json).map(&:to_i)
        cache[:entries].reject! {|e| ids.include?(e[:id]) } unless ids.empty?
        cache[:entries] << {id: (cache[:seq] += 1), meta: JSON.parse(meta_json), response: response_json.to_s}
        nil
      end
      def cache_delete_entries(origin, cache_id, ids_json)
        cache  = cache_for(origin, cache_id) or return 0
        ids    = JSON.parse(ids_json).map(&:to_i)
        before = cache[:entries].size
        cache[:entries].reject! {|e| ids.include?(e[:id]) }
        before - cache[:entries].size
      end
      # The cache hash ({seq:, entries:}) bound to a Cache handle's id, or nil if it's gone.
      private def cache_for(origin, cache_id)
        @cache_storage.dig(origin.to_s, :caches, cache_id.to_i)
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
      # ── Frame-scoped navigation ─────────────────────────────────
      # A self-targeted link click / form submit INSIDE a `within_frame` block
      # navigates just that frame: fetch the document and rebuild the frame's
      # own realm, leaving the top page (its URL, history, status) untouched.
      # Mirrors `navigate` / `navigate_post`'s fetch + redirect-follow but
      # terminates in `reload_current_frame_realm` instead of a main-page boot.

      def navigate_frame(url, depth: 0, entry: @frame_stack.last)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
        if url.to_s.match?(%r{\Aabout:blank(?:[?#]|\z)}i)
          reload_current_frame_realm('about:blank', '', 'text/html', entry: entry)
          return
        end
        env = Rack::MockRequest.env_for(url, method: 'GET')
        apply_default_request_env(env, referer: current_browsing_context_url)
        status, headers, body = dispatch_rack_or_http(url, env, method: 'GET')
        merge_set_cookie(headers, url)
        if (loc = redirect_location(status, headers))
          next_url = carry_fragment(url, resolve_against_current(loc))
          body.close if body.respond_to?(:close)
          return navigate_frame(next_url, depth: depth + 1, entry: entry)
        end
        if download_response?(headers)
          save_downloaded_response(url, headers, body)
          return
        end
        reload_current_frame_realm(url.to_s, read_rack_body(body), response_content_type(headers), entry: entry)
      end

      def navigate_frame_post(url, body, content_type, depth: 0, entry: @frame_stack.last)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
        env = Rack::MockRequest.env_for(url, method: 'POST', input: body)
        env['CONTENT_TYPE']   = content_type.to_s.empty? ? 'application/x-www-form-urlencoded' : content_type
        env['CONTENT_LENGTH'] = body.bytesize.to_s
        apply_default_request_env(env, referer: current_browsing_context_url)
        status, headers, resp_body = dispatch_rack_or_http(url, env, method: 'POST', body: body)
        merge_set_cookie(headers, url)
        if (loc = redirect_location(status, headers))
          next_url = resolve_against_current(loc)
          resp_body.close if resp_body.respond_to?(:close)
          # 301/302/303 → GET; 307/308 preserve method + body (same as navigate_post).
          if [307, 308].include?(status)
            return navigate_frame_post(next_url, body, content_type, depth: depth + 1, entry: entry)
          else
            return navigate_frame(next_url, depth: depth + 1, entry: entry)
          end
        end
        if download_response?(headers)
          save_downloaded_response(url, headers, resp_body)
          return
        end
        reload_current_frame_realm(url.to_s, read_rack_body(resp_body), response_content_type(headers), entry: entry)
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
      def reload_current_frame_realm(url, html, content_type, entry: @frame_stack.last)
        return unless entry
        old_id = entry[:realm_id]
        parent = entry[:parent_realm_id]
        new_id = @runtime.reload_frame_realm(old_id, parent.to_i, url, RuntimeShared.utf8_text(html), content_type).to_i
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

      # Response content-type, defaulting to text/html. Header values can be a
      # bare string or a one-element array (Rack 3 tuple form).
      def response_content_type(headers)
        ct = headers.find {|k, _| k.to_s.downcase == 'content-type' }&.last
        ct = ct.first if ct.is_a?(Array)
        ct.to_s.empty? ? 'text/html' : ct.to_s
      end

      def navigate(url, depth: 0, referer: @current_url, from_history: false)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
        # Capture the entry referer (the page initiating this navigation,
        # e.g. clicked link's host page) at depth 0 — internal redirects
        # at deeper depths don't replace the user-visible referrer.
        # A full-document navigate also clears the pushState transition
        # queue: any URLs we'd queued during the prior page's lifetime
        # are stale once we cross a real document boundary. The pinned
        # user-action baseline is likewise scoped to the prior document —
        # drop it so it can't match (and wrongly suppress) a transition on
        # the new page.
        if depth == 0
          @current_referer = referer.to_s
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
          if url.to_s.match?(%r{\Aabout:blank(?:[?#]|\z)}i)
            @current_url = url.to_s
            record_response(200, {'content-type' => 'text/html'})
            boot_response_into_ctx('')
            return
          end
          unless from_history || depth > 0
            capture_outgoing_form_state
            record_history({method: :get, url: url})
          end
          env = Rack::MockRequest.env_for(url, method: 'GET')
          apply_default_request_env(env, referer: referer)
          status, headers, body = dispatch_rack_or_http(url, env, method: 'GET')
          merge_set_cookie(headers, url)
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
        # A full page (re)build disposes every frame realm, so any active
        # `within_frame` scope is now stale — fall back to the main document.
        # Per-frame session histories are scoped to this document tree; drop them.
        reset_frame_scope
        @frame_histories = nil
        reset_timer_state
        # The response content type drives both the parser choice (XML vs HTML —
        # XHTML/XML/SVG parse case-sensitively, no html/head/body skeleton,
        # `isHtmlDocument` false) and the encoding's HTTP-charset signal.
        ct = (@last_response_headers || {}).find {|k, _| k.to_s.downcase == 'content-type' }&.last
        ct = ct.first if ct.is_a?(Array)
        # HTML document encoding sniffing (the body arrives BINARY-tagged; see
        # `RuntimeShared.utf8_text`). A leading BOM wins (over <meta charset>) and
        # is stripped. Otherwise, for an HTML document with NO encoding signal — no
        # charset in the Content-Type AND no <meta charset> in the prescan — the
        # locale default is windows-1252 and the bytes decode as such; there is NO
        # UTF-8 sniffing (WPT encoding/sniffing). A declared charset keeps the
        # UTF-8 + scrub path (the JS side reports it from the meta; a declared
        # non-UTF-8 multibyte charset is still UTF-8-decoded — legacy multibyte
        # tables are out of scope). The windows-1252 default is HTML-only: an XML
        # document (XHTML/SVG/application+text/xml) defaults to UTF-8, and an empty
        # body (about:blank, a blank 200) stays UTF-8 too.
        decoded, doc_charset = decode_response_bom(html)
        if doc_charset
          html = RuntimeShared.utf8_text(decoded)
        elsif html.to_s.empty? || xml_content_type?(ct) || html_charset_signal?(ct, html)
          html = RuntimeShared.utf8_text(html)
        else
          html = decode_windows1252(html)
          doc_charset = 'windows-1252'
        end
        opts = {
          'traceActive'        => !@trace.nil?,
          'timezone'           => ENV['TZ'].to_s,
          'timeTravelOffsetMs' => ((Time.now.to_f - Process.clock_gettime(Process::CLOCK_REALTIME)) * 1000).to_i,
          'url'                => @current_url.to_s,
          'html'               => html
        }
        opts['contentType'] = ct.to_s if ct && !ct.to_s.empty?
        # The detected document encoding pins document.characterSet (over meta).
        opts['charset'] = doc_charset if doc_charset
        # `document.lastModified` reflects the response Last-Modified header (parsed
        # to local time); absent → the current time (handled JS-side).
        lm = response_headers['Last-Modified']   # response_headers normalizes keys to Capitalized-Dash form
        opts['lastModified'] = lm if lm && !lm.to_s.empty?
        if @viewport_width && @viewport_height
          opts['viewportW'] = @viewport_width
          opts['viewportH'] = @viewport_height
        end
        opts['userAgent'] = @default_user_agent if @default_user_agent
        @document_handle = @runtime.call('__csimBootContext', opts).to_i
        # Drain the app's deferred external-script (chunk) boot chain to quiescence.
        # A dynamically-inserted external <script> runs async (setTimeout 0; HTML
        # "prepare the script" force-async), so a module/chunk loader's scripts
        # haven't executed when boot returns — leaving the page half-booted, where a
        # negative assertion (have_no_*) passes early or a reactive control (a toggle
        # whose handler a chunk wires up) does nothing. `run_loop_step(0)` fires only
        # ALREADY-due timers (the setTimeout(0) chunks + their .then chains, which
        # may insert further due-now chunks), NOT delayed app timers — so the lazy
        # wall-sync clock is preserved (smoke_spec "queries DOM before advancing
        # pending timers"). Bounded by the finite pending-script count.
        if @runtime.respond_to?(:run_loop_step)
          BOOT_SCRIPT_DRAIN_MAX_ITER.times do
            break if @runtime.call('__csimPendingExternalScriptCount').to_i.zero?
            @runtime.run_loop_step(0, SETTLE_MAX_ITER_TASKS, yield_on_gen: false)
          end
        end
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
        saved_location     = @pending_location
        saved_reload       = @pending_reload
        saved_traverse     = @pending_history_traverse
        saved_frame_nav    = @pending_frame_nav
        saved_frame_submit = @pending_frame_submit
        saved_frame_reload = @pending_frame_reload
        begin
          @runtime.run_loop_step(0, SETTLE_MAX_ITER_TASKS, yield_on_gen: false)
        rescue StandardError
          # Outgoing page is discarded next line; its flush error is moot.
        ensure
          @pending_location         = saved_location
          @pending_reload           = saved_reload
          @pending_history_traverse = saved_traverse
          # Don't let a frame-nav / frame-submit / frame-reload intent stashed by
          # an outgoing-page timer leak into the fresh page — its realm id belongs
          # to the discarded page (and a reused context id could mis-fire against
          # an unrelated realm on the new page).
          @pending_frame_nav        = saved_frame_nav
          @pending_frame_submit     = saved_frame_submit
          @pending_frame_reload     = saved_frame_reload
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
        env['HTTP_REFERER'] = referer unless referer.nil? || referer.empty?
        # Attach the TARGET host's cookies (not the document's) — SERVER_NAME is the
        # request's host — so a cross-origin request carries the right jar or none.
        ck = cookie_header_for(env_cookie_host(env))
        if ck.empty?
          env.delete('HTTP_COOKIE')
        else
          env['HTTP_COOKIE'] = ck
        end
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

      # Whether this is a universal-server context (the WPT runner's wptserve shim
      # serves every host in-process). Gates cross-origin eager frame building: in
      # such a context a cross-origin iframe's content IS served locally, so it
      # eager-builds; an ordinary app leaves cross-origin frames lazy (= baseline),
      # so an external embed isn't eager-fetched. A simple flag, NOT per-URL —
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

      # Store a response's Set-Cookie headers under the RESPONDING host's jar (`url` is
      # the hop that produced `headers`). A cross-origin hop therefore writes its own
      # host's jar, never the document's (cors-cookies isolation).
      def merge_set_cookie(headers, url)
        sc = headers['set-cookie'] || headers['Set-Cookie']
        return if sc.nil? || sc.empty?
        host = cookie_host(url) || document_cookie_host or return
        jar  = (@cookies[host] ||= {})
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
            jar.delete(name.strip)
          else
            jar[name.strip] = value.to_s.strip
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

      # Header names/values are TEXT (RFC 9110: field values are ASCII); Rack
      # hands them over BINARY-tagged (see `RuntimeShared.utf8_text`). Per-value HTTP
      # -whitespace normalization happens upstream, BEFORE duplicate values are
      # combined (WptRunner.combine_headers) — not here, where a combined value like
      # `", "` (two empty fields) would wrongly lose its trailing space. An
      # Array-valued header (a Rack app emitting a repeated field) is combined with
      # `, ` — the WHATWG "combine" separator getAllResponseHeaders exposes, matching
      # both real browsers and the harness's combine_headers.
      def stringify(headers)
        out = {}
        headers.each do |k, v|
          out[k.to_s] = RuntimeShared.utf8_text(v.is_a?(Array) ? v.join(', ') : v.to_s)
        end
        out
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
        loc = headers['location'] || headers['Location']
        loc = loc.first if loc.is_a?(Array)   # Rack 3 permits array-valued header fields
        # A blank (or absent) Location has no FOLLOWABLE target: an empty value parses back
        # to the current URL, so following it would just self-redirect. Return nil so a
        # caller renders the 3xx as-is rather than looping — the several navigation handlers
        # rely on this. (The fetch redirect loop recognizes a present-but-empty Location
        # separately and turns it into a network error per Fetch — see rack_fetch.)
        loc unless loc.to_s.empty?
      end

      def resolve_against_current(url, use_base: false)
        return url if url =~ %r{\A[a-z]+://}i
        # Inside a `within_frame` block the "current document" is the frame's,
        # so links / form actions resolve against the frame's URL + <base href>.
        doc_url = current_browsing_context_url || @default_host
        base =
          if use_base && (bh = base_href) && !bh.empty?
            # The document's `<base href>` takes precedence over the
            # request URL when the page's own links / form actions are
            # being resolved — HTML's base-tag semantics. `visit` skips
            # this branch so an address-bar navigation reaches the URL
            # the test typed.
            URI.join(doc_url, bh).to_s
          else
            doc_url
          end
        URI.join(base, url.to_s).to_s
      rescue URI::InvalidURIError, URI::BadURIError
        url
      end

      # The active document's `<base href>` — routed to the current frame realm
      # inside `within_frame`, else the main document.
      def base_href
        dom_call('__csimBaseHref').to_s
      end

      # Fetch "CORS-safelisted method" / "…request-header" / "…Content-Type". A request
      # is "simple" (no preflight) iff its method is safelisted AND every author header is
      # safelisted (Content-Type only for a urlencoded / multipart / text/plain value).
      CORS_SAFELISTED_METHODS = %w[GET HEAD POST].freeze
      CORS_SAFELISTED_HEADERS = %w[accept accept-language content-language content-type].freeze
      # RFC 7230 `token` (tchar+) — a valid HTTP method / field-name. Used to reject a
      # preflight whose Access-Control-Allow-Methods / -Headers carries a malformed value.
      HTTP_TOKEN = /\A[!#$%&'*+\-.^_`|~0-9A-Za-z]+\z/.freeze
      CORS_SAFELISTED_CTYPES  = %w[application/x-www-form-urlencoded multipart/form-data text/plain].freeze
      # Fetch "CORS-unsafe request-header byte" — a byte in a header value that forces a
      # safelisted-name header out of the safelisted set (so a preflight becomes necessary):
      # a control byte other than HT (0x09), DEL, or one of the delimiters "(),:<>?@[\]{}.
      CORS_UNSAFE_VALUE_BYTE  = /[\x00-\x08\x0a-\x1f\x7f"():<>?@\[\\\]{}]/n.freeze
      # accept-language / content-language values are further restricted: only digits,
      # ASCII letters, space, and `*,-.;=` keep them safelisted.
      CORS_LANGUAGE_VALUE     = /\A[0-9A-Za-z *,\-.;=]*\z/n.freeze

      # Fetch "CORS-safelisted request-header": a (name, value) whose value keeps the
      # request "simple" (no preflight). All four names cap the value at 128 bytes; each
      # then constrains which bytes the value may contain (a `"` in Accept, a control byte
      # in Content-Language, an over-long text/plain Content-Type all force a preflight —
      # cors-preflight-not-cors-safelisted).
      def cors_safelisted_request_header?(name, value)
        v = value.to_s.b
        return false if v.bytesize > 128
        case name
        when 'accept'
          !v.match?(CORS_UNSAFE_VALUE_BYTE)
        when 'accept-language', 'content-language'
          v.match?(CORS_LANGUAGE_VALUE)
        when 'content-type'
          return false if v.match?(CORS_UNSAFE_VALUE_BYTE)
          essence = v.split(';', 2).first.to_s.strip.downcase
          CORS_SAFELISTED_CTYPES.include?(essence)
        else
          false
        end
      end

      # The sorted, lowercased author header names that are NOT CORS-safelisted. A
      # safelisted NAME still counts as unsafe when its VALUE fails the safelisting (an
      # unsafe byte / over-128-byte length / non-safelisted Content-Type essence). These
      # are echoed in Access-Control-Request-Headers for the preflight and must be covered
      # by Access-Control-Allow-Headers.
      def cors_unsafe_headers(headers)
        (headers || {}).filter_map {|k, v|
          name = k.to_s.downcase
          next if name.start_with?('x-csim') || name == 'content-length'
          if CORS_SAFELISTED_HEADERS.include?(name)
            cors_safelisted_request_header?(name, v) ? nil : name
          else
            name
          end
        }.uniq.sort
      end

      def cors_unsafe_request?(method, headers)
        !CORS_SAFELISTED_METHODS.include?(method.to_s.upcase) || !cors_unsafe_headers(headers).empty?
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
        u = URI.parse(url.to_s)
        !u.userinfo.to_s.empty?
      rescue URI::InvalidURIError
        false
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
        method_ok = allow_methods.include?(m) || CORS_SAFELISTED_METHODS.include?(m) || (!credentialed && allow_methods.include?('*'))
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
        env    = Rack::MockRequest.env_for(target, method: 'OPTIONS')
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
        status, ph, pbody = dispatch_rack_or_http(target, env, method: 'OPTIONS', body: nil)
        pbody.close if pbody.respond_to?(:close)
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
        return nil unless (allow_methods + allow_headers).all? {|t| t.match?(HTTP_TOKEN) }
        return nil unless cors_grant_allows?(allow_methods, allow_headers, method, unsafe, credentialed)
        {methods: allow_methods, headers: allow_headers, max_age: cors_header(ph, 'access-control-max-age').to_i}
      end

      # Fetch "CORS-safelisted response-header name" — always exposed to script for a
      # cross-origin response, without being listed in Access-Control-Expose-Headers.
      CORS_SAFELISTED_RESPONSE_HEADERS = %w[
        cache-control content-language content-length content-type expires last-modified pragma
      ].freeze

      # The response headers a cross-origin "cors" response exposes to getResponseHeader /
      # getAllResponseHeaders: the CORS-safelisted set plus any named in Access-Control
      # -Expose-Headers. `*` exposes every header, but ONLY for a non-credentialed response;
      # with credentials the wildcard loses its meaning and matches a header literally named
      # `*` (cors-expose-star "only matches literally").
      def cors_exposed_headers(headers, credentialed = false)
        # set-cookie / set-cookie2 are forbidden response-header names — NEVER exposed to
        # script, even when explicitly named in Access-Control-Expose-Headers or covered by
        # `*` (cors-filtering "header is forbidden"). x-csim-status-text is our internal
        # reason-phrase sentinel (response_hash lifts it into statusText, which IS exposed
        # cross-origin, then strips it from the script-visible map), so it must survive.
        forbidden = %w[set-cookie set-cookie2]
        expose    = cors_list(cors_header(headers, 'access-control-expose-headers')).map(&:downcase)
        if !credentialed && expose.include?('*')
          return headers.reject {|k, _| forbidden.include?(k.to_s.downcase) }
        end
        allowed = CORS_SAFELISTED_RESPONSE_HEADERS + expose + ['x-csim-status-text']
        headers.select {|k, _| allowed.include?(k.to_s.downcase) && !forbidden.include?(k.to_s.downcase) }
      end

      # Case-insensitive response-header lookup + comma-list split for the CORS checks.
      def cors_header(headers, name)
        pair = headers.find {|k, _| k.to_s.downcase == name }
        pair&.last.to_s
      end

      def cors_list(value)
        value.to_s.split(',').map(&:strip).reject(&:empty?)
      end

      # The origin of a URL — `scheme://host[:port]` with the default port (80/443)
      # elided — for the CORS same/cross-origin comparison. nil for a non-http(s) or
      # unparseable URL (about:blank / data: / a relative current_url) so CORS never
      # treats those as a comparable origin.
      def url_origin(url)
        u = URI.parse(url.to_s)
        return nil unless u.scheme && u.host && u.scheme.match?(/\Ahttps?\z/i)
        # An origin is (scheme, host, port) compared case-insensitively on scheme+host —
        # so canonicalize both to lowercase, else http://Example.com vs http://example.com
        # would mis-classify a same-origin request as cross-origin.
        scheme  = u.scheme.downcase
        default = scheme == 'https' ? 443 : 80
        port    = u.port && u.port != default ? ":#{u.port}" : ''
        "#{scheme}://#{u.host.downcase}#{port}"
      rescue URI::InvalidURIError
        nil
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
        def visit(url, referer: nil)
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
