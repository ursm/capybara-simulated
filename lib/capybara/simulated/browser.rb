# frozen_string_literal: true

require 'base64'
require 'date'
require 'fileutils'
require 'json'
require 'nokogiri'
require 'rack/mock'
require 'socket'
require 'thread'
require 'time'
require 'uri'
require_relative 'asset_cache'
require_relative 'errors'
require_relative 'esm_rewriter'
require_relative 'stack_resolver'
require_relative 'trace'

module Capybara
  module Simulated
    class Browser
      DEFAULT_HOST = 'http://www.example.com'

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
      # Brief window after a Ruby-side navigate (context rebuild) so
      # Capybara's outer synchronize gets one retry against the new
      # context.
      POST_NAV_POLL_GRACE_POLLS = 10
      # Virtual JS clock advances by a fixed step per tick_real_time
      # call so timer firing order is identical across runs regardless
      # of wall-clock pressure (GC, core competition). The driver's
      # "deterministic" contract depends on this.
      TICK_STEP_MS = 50
      SETTLE_DRAIN_MS = 32
      SETTLE_MAX_ITER = 10
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
      USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; Rails Testing) capybara-simulated (V8-resident DOM)'
      REMOTE_ADDR = '127.0.0.1'

      def initialize(app, driver: nil, js_engine: nil)
        @app                          = app
        @driver                       = driver
        @runtime                      = build_runtime(js_engine)
        @current_url                  = nil
        @cookies                      = {}
        @local_storage                = {}
        @session_storage              = {}
        @sticky_headers               = {}
        @timers_active                = false
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
        @ticking                      = false
        @history                      = []
        @history_idx                  = -1
        @modal_handlers               = []
        @module_cache                 = {}
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
        # Web Workers — per-Browser handle counter, per-worker
        # {thread, inbox} pair, and a shared outbox the main settle
        # drains via `__csim_deliverWorkerMessages`. Each worker
        # thread owns its own V8 Context / QuickJS VM (real isolate);
        # cross-isolate messaging is JSON-marshalled.
        @worker_seq    = 0
        @workers       = {}
        @worker_outbox = Thread::Queue.new
        # Cross-isolate `blob:` URL store. Worker isolates can't see
        # the main scope's `__csimBlobs` Map, so the main scope mirrors
        # blob bytes (base64) here and workers resolve them through a
        # host fn.
        @blob_registry = {}
        @blob_registry_lock = Mutex.new
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

      # `console.*` short-circuits to a property read when this flag
      # is false (see `lib/capybara/simulated/js/bridge.js`). The flag is a JS-side
      # global, so it has to be re-applied after every `rebuild_ctx`
      # while a trace is live — without this, page scripts that run
      # during the per-visit `__csimLoadDocument` log to a stale
      # (false) flag and their console output is dropped from the
      # trace.
      def apply_trace_flag
        @runtime.call('__csimSetTraceActive', !@trace.nil?)
      end

      # The viewport size lives on the JS-side `globalThis.innerWidth`
      # / `globalThis.innerHeight` slots. Per-visit `rebuild_ctx` boots
      # a fresh Context from the snapshot (1024×768) so we have to
      # re-apply a resize made before the visit. Caller-level resizes
      # via `set_viewport` use the same setter directly.
      def apply_viewport
        return unless @viewport_width && @viewport_height
        @runtime.eval("globalThis.innerWidth = #{@viewport_width}; globalThis.innerHeight = #{@viewport_height};")
      end

      # V8 caches the local-zone resolution at platform init; tests
      # that flip `ENV['TZ']` per example (Avo's `tz:` metadata)
      # otherwise leave Luxon's `DateTime.local()` and Avo's
      # date_field controller reading the boot-time zone. The bridge
      # patches `Intl.DateTimeFormat`'s default `timeZone` to this
      # Ruby-supplied target — Luxon's `SystemZone` routes through
      # Intl so the override propagates to the user-visible date.
      # Per-visit Context rebuilds reset the JS-side override, so
      # we always re-apply after `rebuild_ctx` regardless of whether
      # ENV['TZ'] changed.
      def apply_timezone
        @runtime.call('__csimSetTimezone', ENV['TZ'].to_s)
      end

      # ── Capybara DSL surface ────────────────────────────────────

      # Address-bar navigation: no Referer, and relative paths resolve
      # against the host root (not the current page's directory).
      def visit(url)
        navigate(resolve_visit_url(url), referer: nil)
      end

      def resolve_visit_url(url)
        s = url.to_s
        return s if s =~ %r{\A[a-z]+://}i
        host_root = (begin URI.parse(@current_url) rescue nil end)&.tap {|u| u.path = ''; u.query = nil; u.fragment = nil }&.to_s || DEFAULT_HOST
        host_root = host_root.sub(/\/+$/, '')
        s = "/#{s}" unless s.start_with?('/')
        "#{host_root}#{s}"
      end

      def current_url
        tick_real_time
        @current_url || ''
      end

      # Capybara routes plenty of compound CSS — `[type='submit']` /
      # pseudo classes / sibling combinators — through `find_css` even
      # when the resolved locator is XPath. The JS-side selector parser
      # is intentionally minimal (tag / id / class / attr / descendant
      # / grouping). To get full Capybara coverage without growing
      # the JS parser, route through Nokogiri's CSS → XPath translator
      # and reuse `find_xpath`; the JS parser stays the fast path
      # for the simple selectors customElements / framework code
      # emits internally.
      # Dynamic pseudo-classes that depend on runtime state (focus,
      # interaction) instead of static DOM shape. Nokogiri's CSS-to-
      # XPath emits `nokogiri:focus(...)` for these, which wgxpath
      # can't evaluate (extension functions aren't registered),
      # silently returning empty. The JS-side parser DOES handle them,
      # so we shortcut around the XPath path entirely when we see one.
      DYNAMIC_PSEUDO_RE = /:(focus|focus-within|focus-visible|hover|active|checked|disabled|enabled|valid|invalid|required|optional|read-only|read-write|placeholder-shown|target)\b/

      def find_css(css, context_handle = nil)
        s = css.to_s
        if xpath_shaped?(s)
          return find_xpath(s, context_handle)
        end
        unless s.match?(DYNAMIC_PSEUDO_RE) || scoped_chain_selector?(s, context_handle)
          begin
            # When scoped, emit context-relative XPath (`.//`) so wgxpath
            # honors the context node. Without the prefix Nokogiri returns
            # `//` (descendant-of-root) which ignores `context_handle` and
            # collects matches across the whole document — surfaced as
            # `Capybara::Ambiguous` whenever a within() block expected one
            # element (e.g. Redmine's ReactionsSystemTest scoped to a span).
            prefix = context_handle ? './/' : '//'
            xpaths = Nokogiri::CSS.xpath_for(s, prefix: prefix)
            unless xpaths.empty?
              # Comma groups emit one xpath each — union with ` | `.
              combined = xpaths.length == 1 ? xpaths.first : xpaths.join(' | ')
              return find_xpath(combined, context_handle)
            end
          rescue Nokogiri::CSS::SyntaxError, StandardError
            # Fall back to the JS-side parser. Worth trying because
            # `xpath_for` can choke on Capybara-emitted pseudo selectors
            # (`:not(...)`, attribute case-insensitive flags) that our
            # JS path either supports or ignores predictably.
          end
        end
        find_with_timer_fallback(:css, s, context_handle) do
          @runtime.call('__csimQuery', context_handle || @document_handle, s).to_a
        rescue StandardError => e
          # Match `document.querySelectorAll`'s `DOMException(SyntaxError)`
          # behavior for an invalid selector: real browsers throw, but
          # Capybara's `has_no_css?` doesn't catch it either — it just
          # times out the wait and reports "not present". Mirror "not
          # present" here by returning empty; downstream callers that
          # genuinely need the error path can probe via `evaluate_script`.
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

      # JS engine surfaces an invalid-CSS-selector throw as
      # `Quickjs::SyntaxError` (QuickJS, dynamic class via JS-name mapping)
      # or `MiniRacer::RuntimeError` (V8). Match by class name suffix so
      # neither gem becomes a hard dependency here.
      def syntax_or_invalid_selector_error?(e)
        name = e.class.name.to_s
        return true if name.end_with?('::SyntaxError')
        return true if e.message.to_s.start_with?('csim: unexpected selector', 'csim: bad attr selector', 'csim: stray &')
        false
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

      # CSS qsa spec: `el.querySelectorAll("a b c")` matches the
      # selector against the document, then filters to descendants of
      # `el`. Nokogiri::CSS.xpath_for with the `.//` prefix instead
      # requires `a`, `b`, `c` to all be inside the context, so a
      # `find_all("table tbody tr td")` inside a `<tr>` scope returns
      # zero matches. Falling back to the JS-side qsa (whose
      # `matchComplex` walks the *document* ancestor chain) is the
      # correct way to honour CSS semantics; the heuristic catches any
      # selector with a combinator and a context.
      COMBINATOR_RE = /[\s>+~]/
      def scoped_chain_selector?(s, context_handle)
        return false unless context_handle
        # Strip the inside of `:not(...)` / `:is(...)` etc. before
        # probing — a combinator inside a pseudo doesn't add an
        # outer ancestor step and is safe for the Nokogiri path.
        stripped = s.gsub(/\([^()]*\)/, '')
        stripped.match?(COMBINATOR_RE)
      end

      # XPath is evaluated *inside* V8 against the live JS DOM via
      # wgxpath (vendored, installed at snapshot build). One IPC per
      # `find_xpath` — no serialise + reparse round-trip. Set
      # `CSIM_XPATH=nokogiri` to fall back to a serialize-and-reparse
      # path through libxml2 (Element handles travel as
      # `data-csim-handle` attributes on the serialised subtree) when
      # wgxpath chokes on a query.
      XPATH_BACKEND = ENV['CSIM_XPATH'] == 'nokogiri' ? :nokogiri : :wgxpath
      def find_xpath(xpath, context_handle = nil)
        xpath_str = xpath.to_s
        find_with_timer_fallback(:xpath, xpath_str, context_handle) do
          if XPATH_BACKEND == :nokogiri
            find_xpath_via_nokogiri(xpath, context_handle)
          else
            @runtime.call('__csimEvaluateXPath', xpath_str, context_handle || 0).to_a
          end
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

      FIND_PRE_TICK_MIN_S = 0.05
      def timer_wait_elapsed?
        @timers_active &&
          (Process.clock_gettime(Process::CLOCK_MONOTONIC) - @last_tick_ts) >= FIND_PRE_TICK_MIN_S
      end

      # Single-slot cache for the most recent find_xpath / find_css /
      # find_first_css result. Capybara's `synchronize` retry loop
      # re-issues the same find on every poll while waiting for an
      # element to appear or disappear; if no DOM-mutating event has
      # happened since the last call (no timer fired, no click / set /
      # navigate), the result is guaranteed identical and we can skip
      # the V8 round-trip + wgxpath traversal.
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

      # Kept as a fallback / debug aid. Same semantics as the wgxpath
      # path but routes through Nokogiri::HTML5 — useful when wgxpath
      # rejects a query Capybara emits.
      def find_xpath_via_nokogiri(xpath, context_handle = nil)
        html = @runtime.call('__csimSerialize', 0).to_s
        return [] if html.empty?
        doc  = Nokogiri::HTML5.parse(html)
        root = context_handle ? doc.at_xpath("//*[@data-csim-handle='#{context_handle}']") : doc
        return [] unless root
        root.xpath(xpath.to_s).filter_map {|n|
          n.respond_to?(:[]) ? n['data-csim-handle']&.to_i : nil
        }.reject(&:zero?)
      end

      def text(handle)        = @runtime.call('__csimText', handle).to_s
      def tag(handle)         = @runtime.call('__csimTag', handle).to_s
      def attr(handle, name)  = @runtime.call('__csimAttr', handle, name.to_s)
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

      def click(handle, keys = [], **opts)
        tick_real_time
        invalidate_find_cache
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
        env['HTTP_USER_AGENT'] = USER_AGENT
        env['REMOTE_ADDR']     = REMOTE_ADDR
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
              'type'         => '',
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
        items = args.flat_map {|arg| drop_items(arg) }
        @runtime.call('__csimDropOnto', handle, items)
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
        init = {'bubbles' => true, 'cancelable' => true}.merge(click_event_init(handle, keys, opts))
        @runtime.call('__csimDispatchEvent', handle, 'dblclick', init)
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
        @runtime.call('__csimSendKeys', handle, atoms)
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
          @runtime.drain_microtasks(SETTLE_MICRO_DRAIN_PER_ITER)
          deliver_event_source_events
          deliver_worker_messages
          break if @runtime.settle_gen > start_gen
          break unless @timers_active || event_source_pending? || worker_pending?
          @runtime.drain_timers(SETTLE_DRAIN_MS) if @timers_active
          deliver_event_source_events
          deliver_worker_messages
          break if @runtime.settle_gen > start_gen
          # No progress this iter (no DOM/URL change observed) — the
          # remaining timers are queued for the future; bail and let
          # Capybara's wall-clock-driven poll loop drive the next tick
          # via `tick_real_time`. SSE / Worker channels keep us in
          # the loop as long as background threads have data queued.
          break if @runtime.settle_gen == prev_gen && !@runtime.has_ready_timer? && !event_source_pending? && !worker_pending?
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
        url = pending['url'].to_s
        if pure_fragment_navigation?(url)
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
        # Re-fire a `resize` event so libraries that re-layout on
        # resize (responsive nav, sidebar collapse) see the new size.
        @runtime.eval("try { (globalThis.dispatchEvent || function(){})(new Event('resize')); } catch (_) {}")
        nil
      end
      def viewport_width                  ; @viewport_width  || 1024 ; end
      def viewport_height                 ; @viewport_height || 768  ; end
      def go_back
        return if @history_idx <= 0
        @history_idx -= 1
        replay_history_entry(@history[@history_idx])
      end
      def go_forward
        return if @history_idx + 1 >= @history.size
        @history_idx += 1
        replay_history_entry(@history[@history_idx])
      end
      def record_history(entry)
        # Discard any forward-history tail (a real browser drops the
        # redo stack the moment you navigate after a `go_back`).
        @history = @history[0..@history_idx] if @history_idx + 1 < @history.size
        @history << entry
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
      def send_session_key(key)
        sym = key.is_a?(Symbol) ? key : (key.respond_to?(:to_sym) ? key.to_sym : nil)
        case sym
        when :tab       then @runtime.call('__csimAdvanceFocus',  false)
        when :backtab   then @runtime.call('__csimAdvanceFocus',  true)
        else
          handle = active_element_handle
          send_keys(handle, [key]) if handle
        end
      end
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
        @runtime.call('__csimEvalScript', code.to_s, marshal_args(args || []))
      end

      # Fire-and-forget variant: runs the script but never returns
      # its value to Ruby. Lets execute_script handle scripts whose
      # return is a complex JS object (jQuery chainable, DOM tree,
      # …) that mini_racer's value filter would recurse into.
      def execute_script(code, args = [])
        tick_real_time
        invalidate_find_cache
        @runtime.call('__csimExecScript', code.to_s, marshal_args(args || []))
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
      def polling?
        if @timers_active
          @polling_grace = POLLING_GRACE_POLLS
          true
        elsif @polling_grace && @polling_grace > 0
          @polling_grace -= 1
          true
        else
          false
        end
      end

      # Advance the virtual JS clock by `step_ms` and fire timers that
      # came due. Each find / has_? path enters here with the default
      # step; `SleepHook` calls in via `advance_virtual_clock_ms` with
      # the explicit duration from `Kernel#sleep(n)`.
      def tick_real_time(step_ms: TICK_STEP_MS)
        return unless @timers_active || worker_pending? || event_source_pending?
        # Re-entrancy guard. Capybara's `Result#each` triggers nested
        # finds (visible? per element); the outermost tick has already
        # advanced the clock, the inner calls would only re-drain
        # already-fired timers.
        return if @ticking
        @ticking = true
        begin
          @last_tick_ts = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          if @timers_active && step_ms > 0
            fired = @runtime.drain_timers(step_ms).to_i
            @find_cache_dirty = true if fired > 0
          end
          # Pull any pending Worker / EventSource messages into JS
          # state. Without this, `evaluate_script` after kicking off
          # a worker round-trip would see stale state — the inbox
          # outbox only drains during `settle`, which doesn't run
          # for direct `execute_script` / `evaluate_script` calls.
          @find_cache_dirty = true if deliver_worker_messages > 0
          @find_cache_dirty = true if deliver_event_source_events > 0
        ensure
          @ticking = false
        end
        # Drain navigation intents queued by JS-side handlers that fired
        # during the drain (e.g. `setTimeout(() => location.pathname = X)`).
        # Outside the @ticking guard so the navigate's rebuild_ctx is
        # well-clear of the V8 call we just made.
        consume_pending_location if @pending_location
        consume_pending_reload if @pending_reload
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
        @last_tick_ts  = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @timers_active = false
        @polling_grace = nil
        @context_gen  += 1
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
        action_url = action.empty? ? (@current_url || DEFAULT_HOST) : resolve_against_current(action)
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
        status, headers, resp_body = @app.call(env)
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
        # mobile-collapsed-by-default).
        @viewport_width = nil
        @viewport_height = nil
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
        reset_workers
        @blob_registry_lock.synchronize { @blob_registry.clear }
        @runtime.reset_page
        # Per-visit ctx rebuild drops the JS-side trace-active flag,
        # so re-flip it if we're carrying a pending trace into the
        # next visit.
        @runtime.call('__csimSetTraceActive', false)
        reset_timer_state
        invalidate_find_cache
      end

      # ── Host-fn callbacks invoked by bridge.js ──────────────────

      # JS-side loader callback: hand back the rewritten module body
      # for `url` (import specifiers resolved through the active
      # importmap + EsmRewriter applied). Cached at Browser scope so
      # the rewrite cost is paid once per (URL, importmap) — the cache
      # survives Context rebuilds (between-test reset + per-navigate
      # rebuild) and is flushed only when `set_importmap` detects a
      # change. Inline modules are pre-registered via the JS-side
      # `__csim_inlineSources` map, indexed by hashed-body URL — we
      # surface them here so the same cache covers both paths.
      def load_module(url)
        return @module_cache[url] if @module_cache.key?(url)
        body =
          if url.to_s.include?('#inline-')
            # Inline-module sentinel: when the JS bridge sees a
            # `<script type="module">` without `src`, it synthesises a
            # URL of the form `<page>#inline-<hash>` and stashes the
            # body in `__csim_inlineSources[url]`. Pull it back.
            inline = @runtime.eval("(globalThis.__csim_inlineSources || {})[#{url.to_json}] || null")
            inline&.to_s
          else
            rack_fetch_body(url)
          end
        return @module_cache[url] = nil unless body
        resolved  = rewrite_module_imports(body, url)
        rewritten = EsmRewriter.rewrite(resolved, url: url).first
        @module_cache[url] = rewritten
      end

      def rack_fetch_body(url)
        result = rack_fetch('GET', url, '', {}, 'follow')
        return nil unless result && result['status'].to_i < 400
        result['body'].to_s
      end

      # Native-ESM entry point — only the QuickJS runtime registers this
      # path (its `vm.module_loader` handles transitive imports, live
      # bindings, `import.meta`, and `import()` per the ES spec). V8
      # stays on bridge.js's JS-side loader + `EsmRewriter` because
      # mini_racer doesn't yet expose V8's Module API.
      def eval_esm_module(url, src = nil)
        return nil unless @runtime.respond_to?(:eval_esm_module)
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
      end

      def deliver_worker_messages
        return 0 if @workers.empty? && @worker_outbox.empty?
        events = drain_queue(@worker_outbox)
        return 0 if events.empty?
        @runtime.call('__csim_deliverWorkerMessages', events)
        events.size
      end

      def worker_pending? = !@worker_outbox.empty?

      # ── Image decode (libvips) ─────────────────────────────────────
      #
      # Called by the JS bridge whenever a Canvas / OffscreenCanvas
      # path needs raw RGBA pixels — `drawImage(image, …)` whose
      # source is an HTMLImageElement / Blob / ImageBitmap with
      # encoded bytes still on the wire. ruby-vips decodes any format
      # libvips supports (PNG, JPEG, WebP, GIF, …) into a contiguous
      # row-major RGBA buffer. Returned as base64 because mini_racer /
      # quickjs.rb string transport reinterprets binary as UTF-8;
      # JS-side `atob` + `Uint8ClampedArray` rebuilds the pixel buffer
      # exactly. Optional `max_w`/`max_h` lets the caller pre-shrink
      # for cheap OCR-style "downscale before pixel-touch" flows.
      def decode_image(b64_bytes, max_w = nil, max_h = nil)
        require 'vips' unless defined?(Vips)
        bytes = Base64.decode64(b64_bytes.to_s)
        img   = Vips::Image.new_from_buffer(bytes, '')
        img   = img.colourspace('srgb')
        img   = img.bandjoin(255) if img.bands < 4
        if max_w && max_h && max_w.to_i > 0 && max_h.to_i > 0 &&
           (img.width > max_w.to_i || img.height > max_h.to_i)
          shrink_x = img.width.to_f  / max_w.to_i
          shrink_y = img.height.to_f / max_h.to_i
          shrink  = [shrink_x, shrink_y].max
          img     = img.resize(1.0 / shrink) if shrink > 1
        end
        raw = img.write_to_memory
        {'width' => img.width, 'height' => img.height, 'pixels' => Base64.strict_encode64(raw)}
      rescue StandardError => e
        warn "[capybara-simulated] decode_image failed: #{e.class}: #{e.message[0, 200]}"
        nil
      end

      def reset_workers
        @workers.each_value do |w|
          w[:inbox] << :terminate
          w[:thread].kill
        end
        @workers.clear
        @worker_outbox.clear
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

      # Worker thread entry. Builds an isolate via the engine class's
      # `build_worker` factory, evaluates the worker script, then
      # loops draining microtasks + timers + inbox until `:terminate`
      # lands or an exception propagates.
      private def run_worker(handle, url, body, inbox, outbox, engine_class)
        raise "worker script not found: #{url}" unless body
        post_back = ->(data) { outbox << {handle: handle, kind: 'message', data: data.to_s} }
        rt        = engine_class.build_worker(self, post_back)
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

      # Resolve every static / dynamic import specifier in `source` to
      # an absolute URL so EsmRewriter (and the JS-side loader) can
      # treat them as opaque keys. Bare specifiers go through the
      # importmap; everything else is URL-joined against the importer.
      # Match every quoted URL inside a module-level import / export-from
      # statement so we can resolve it against the importer's base URL
      # before EsmRewriter sees it. Two shapes:
      #
      #   `import[ …]"url"`     — any of bare / default / named / namespace
      #   `export {…|*}[ as X] from "url"` — re-export shapes only
      #
      # Vite/Rolldown's minified output omits whitespace
      # (`import{x}from"foo"`), so the binding region is captured as
      # "non-quote chars OR balanced braces" rather than relying on
      # `\s+`-separated chunks. The lookahead `(?=[\s'"{*])` after
      # `\bimport` rejects `import.meta` / `importx` / etc. while
      # allowing every legitimate import follow-up token. Exports use a
      # narrower form that *requires* `from` so `export const x = "…"`
      # doesn't get its string literal mis-resolved as a module URL.
      MODULE_IMPORT_RE = %r<
        (?<lead>(?:^|[^\w$.]))
        (?<static>
          (?:
            import\b(?=[\s'"{*])
            (?:[^'"\n;{}]|\{[^}]*\})*
            |
            export\b\s*(?:\*|\{[^}]*\})(?:\s*\bas\b\s+\w+)?\s*\bfrom\b\s*
          )
        )(?<q1>['"])(?<spec1>[^'"\n]+)\k<q1>
        |
        (?<lead2>[^\w$.])
        (?<dynamic>import\s*\(\s*)
        (?<q2>['"])(?<spec2>[^'"\n]+)\k<q2>
      >x.freeze
      def rewrite_module_imports(source, base_url)
        source.gsub(MODULE_IMPORT_RE) do
          m        = Regexp.last_match
          spec     = m[:spec1] || m[:spec2]
          quote    = m[:q1]    || m[:q2]
          resolved = resolve_module_specifier(spec, base_url)
          prefix   = m[:static] || m[:dynamic]
          lead     = m[:lead]   || m[:lead2]
          "#{lead}#{prefix}#{quote}#{resolved}#{quote}"
        end
      end

      # JS-side `ingestImportmaps` calls this through the host fn so
      # Ruby-side `resolve_module_specifier` and JS-side
      # `__csim_resolveSpecifier` agree on the bare-specifier map.
      # Flush `@module_cache` whenever the importmap actually changes —
      # cached module bodies embed import URLs that were resolved
      # against the previous map. For apps with a stable importmap
      # across pages (the common case) this preserves cache hits
      # across navigations.
      def set_importmap(json)
        parsed = begin
          JSON.parse(json.to_s)
        rescue JSON::ParserError
          {'imports' => {}, 'scopes' => {}}
        end
        @module_cache = {} if @importmap && @importmap != parsed
        @importmap = parsed
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
        URI.join(base || @current_url || DEFAULT_HOST, url).to_s
      rescue URI::InvalidURIError
        url
      end

      MAX_FETCH_REDIRECTS = 20
      # URLs we won't even try to route through Rack: anything that
      # isn't http(s) (data: / mailto: / about:) plus pseudo-tokens
      # like V8's `<snapshot>` that sourcemap libraries pull out of
      # error stacks and feed straight to `fetch()` / `xhr.open()`.
      def rack_fetch(method, url, body, headers, redirect_mode)
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
          status, resp_headers, resp_body = @app.call(env)
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

      def response_hash(status, headers, body, url, redirected)
        # `body` keeps the legacy UTF-8 transport — fine for the >95%
        # text/json/css/js path. `body_b64` ships the raw bytes
        # base64-encoded so the binary consumers (fetch's
        # `arrayBuffer()` / `blob()`, ActiveStorage Blob loops) get
        # the original bytes intact through the mini_racer /
        # quickjs.rb UTF-8 string boundary. Without it, V8 mangles
        # bytes 0x80-0xFF in binary payloads (Tesseract.js's 10 MB
        # `eng.traineddata.gz` would round-trip corrupted, OCR
        # recognises nothing in the image).
        {
          'status'     => status,
          'headers'    => stringify(headers),
          'body'       => body,
          'body_b64'   => Base64.strict_encode64(body.to_s),
          'url'        => url,
          'redirected' => redirected,
          'type'       => 'basic'
        }
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
      def history_state(url) ; @current_url = resolve_against_current(url.to_s) ; end
      # `history.pushState` from SPA navigation (Turbo Visit, InstantClick,
      # …) appends a new browser-history entry. Mirror that on the Ruby
      # side so `Capybara#go_back` can replay it. Without this, the only
      # entries in `@history` come from `visit` / `navigate` (full page
      # loads), and `page.go_back` from a Turbo-Visit-rendered page no-ops.
      def history_push(url)
        resolved = resolve_against_current(url.to_s)
        @current_url = resolved
        record_history({method: :get, url: resolved})
      end
      def document_cookie      ; @cookies.map {|k, v| "#{k}=#{v}" }.join('; ') ; end
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
        record_history({method: :get, url: url}) unless from_history || depth > 0
        env = Rack::MockRequest.env_for(url, method: 'GET')
        apply_default_request_env(env, referer: referer)
        status, headers, body = @app.call(env)
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
        if download_response?(headers)
          save_downloaded_response(url, headers, body)
          return
        end
        @current_url = url
        record_response(status, headers)
        html         = read_rack_body(body)
        # @module_cache and @importmap survive across navigates;
        # set_importmap flushes the cache only when the new page
        # ships a different importmap (handles cross-app navigation).
        # Full-reload navigation rebuilds the JS Context from the warm
        # snapshot. Per-visit fresh VM avoids partial-reset drift
        # (jQuery `.ready`, rails-ujs `_rails_loaded`, accumulated
        # `$(document).on(...)` delegates) — snapshot warmup keeps the
        # rebuild itself cheap; app-bundle re-eval dominates.
        boot_response_into_ctx(html)
      end

      # Rebuild the JS Context and load `html` into it. Called from
      # every code path that handles a full-page Rack response (`navigate`
      # for GETs, `navigate_post` for POSTs). `__csimLoadDocument` walks
      # importmaps + module scripts during `runInlineScripts`; the bridge
      # pushes the importmap back via `__csim_pushImportmap` before any
      # module loads, so `load_module` sees the fully-merged map.
      #
      # The post-nav grace bridges Capybara's outer-synchronize gap when
      # the new page has no scripts of its own to flip `@timers_active`
      # (e.g. Avo's `redirect_to main_app.hey_path` → static view). Kept
      # small (~10 retry intervals) so failing-assertion paths don't pay
      # for the wait.
      def boot_response_into_ctx(html)
        @runtime.rebuild_ctx
        reset_timer_state
        apply_trace_flag
        apply_viewport
        apply_timezone
        @runtime.call('__csimUpdateLocation', @current_url.to_s)
        @document_handle = @runtime.call('__csimLoadDocument', html).to_i
        @polling_grace = POST_NAV_POLL_GRACE_POLLS
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
        if force
          env['HTTP_USER_AGENT'] = USER_AGENT
          env['REMOTE_ADDR']     = REMOTE_ADDR
          @sticky_headers.each {|k, v| env["HTTP_#{k.upcase.tr('-', '_')}"] = v }
        else
          env['HTTP_USER_AGENT'] ||= USER_AGENT
          env['REMOTE_ADDR']     ||= REMOTE_ADDR
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
            URI.join(@current_url || DEFAULT_HOST, bh).to_s
          else
            @current_url || DEFAULT_HOST
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
