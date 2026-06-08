# frozen_string_literal: true

# mini_racer Context wrapper. The DOM lives in JS; this class owns the
# V8 context, the warm snapshot, the host-fn callbacks the bridge reaches
# back through, and the per-visit `rebuild_ctx` dance.
#
# `QuickJSRuntime` is the alternate implementation; both expose the same
# surface (`eval` / `call` / `drain_timers` / `drain_microtasks` /
# `settle_gen` / `has_ready_timer?` / `reset_timers` / `rebuild_ctx` /
# `reset_page`). Browser picks one at construction.

require 'digest'
require 'fileutils'
require 'mini_racer_csim'
require 'set'

require_relative 'runtime_shared'
require_relative 'script_cache'
require_relative 'worker_runtime'


begin
  stack_kb = (ENV['CSIM_V8_STACK_KB'] || '2000').to_i
  # `:single_threaded` mode is for production fork-safety. csim tests
  # never fork mini_racer contexts, and the mode actively breaks two
  # things we need: `eval` deadlocks on certain reentrant patterns
  # (see `feedback_v8_backend_progress` memory) and cross-process
  # bytecode cache blobs become process-local (V8 embeds isolate
  # state in `CreateCodeCache` under single-threaded). Always run
  # multi-threaded.
  MiniRacerCsim::Platform.set_flags!(stack_size: stack_kb)
  # Default V8 old-space cap is ~1.4 GB, which OOMs on workloads that
  # marshal large pixel buffers across postMessage (Discourse's
  # media-optimization-worker hands a 317 MB raw RGBA frame from an
  # 8900×8900 fixture through bytesToLatin1 + btoa + JSON before the
  # transfer; the encode chain peaks at ~1.4 GB by itself). Match
  # Discourse's own testem flag of 4 GB so the test fits.
  max_old_mb = (ENV['CSIM_V8_MAX_OLD_SPACE_MB'] || '4096').to_i
  MiniRacerCsim::Platform.set_flags!('max-old-space-size': max_old_mb) if max_old_mb > 0
  # `CSIM_V8_PROF=1` turns on V8's tick-sampling profiler. Output
  # lands in `isolate-*-v8.log`; process with:
  #   node --prof-process isolate-*-v8.log > prof.txt
  # (Standard Node distribution ships the post-processor; no extra
  # install needed.) The log is per-isolate, so per-visit
  # `rebuild_ctx` produces one file per Context.
  if ENV['CSIM_V8_PROF'] == '1'
    MiniRacerCsim::Platform.set_flags!(:prof, 'logfile-per-isolate': nil)
  end
rescue MiniRacerCsim::PlatformAlreadyInitialized
end

module Capybara
  module Simulated
    class V8Runtime

      @@snapshot_lock = Mutex.new
      @@snapshot      = nil
      @@live_lock     = Mutex.new
      @@live          = []

      # Cross-visit cache of ESM module sources keyed by URL → [sha, body,
      # fresh_until]. `clear_volatile` drops cacheable bodies from the volatile
      # asset cache every visit, so without this the loader re-fetches every
      # module source from the server each visit JUST to recompute the SHA that
      # keys the (disk-persisted, already-warm) bytecode cache.
      #
      # This deliberately SURVIVES the visit boundary (that is the point), so —
      # unlike the volatile asset cache — `clear_volatile` does NOT bound it.
      # Its safety rests on: (a) entries are stored only for responses the
      # server marks durably cacheable (`Browser#module_source` returns a
      # non-nil `fresh_until` — header-driven, not a URL-shape guess; no-store /
      # no-cache / max-age=0 yield nil and are re-fetched), and only honoured
      # while still fresh; and (b) these are ESM MODULES — content-stable app
      # code served at content-hashed URLs, so a content change yields a new URL
      # (cache miss), unlike a dynamic response whose body can change under a
      # stable URL. Size-capped to bound process memory.
      @@module_src      = {}
      @@module_src_lock = Mutex.new
      MODULE_SRC_MAX    = 4096

      at_exit do
        @@live_lock.synchronize {
          @@live.each {|c|
            begin
              c.stop rescue nil
              c.dispose
            rescue StandardError
            end
          }
          @@live.clear
        }
      end

      def self.snapshot
        @@snapshot_lock.synchronize { @@snapshot ||= build_snapshot }
      end

      # Pre-warm script: exercises the JS surfaces that get JIT-compiled
      # on every page load (HTML parse, selector tokenise + match, event
      # dispatch, style-decl parse, cascade resolve). Runs once at
      # snapshot creation; the resulting bytecode-cache state ships in
      # the snapshot so each new Context starts with these paths warm.
      SNAPSHOT_WARMUP = <<~JS.freeze
        (function () {
          // Drive a representative document through parse → script
          // eval → selector / event / cascade primitives so the
          // bytecode cache covers them when a real visit hits.
          const html = '<!doctype html><html><head><style>' +
            '.a { display: none } .a.show { display: block }' +
            '#m, .b > .c { visibility: hidden }' +
            '@media (max-width: 899px) { .b { display: none } }' +
            '</style></head><body>' +
            '<div id="m" class="a"><span class="b"><a class="c" href="/x">x</a></span></div>' +
            '<form><input name="q" type="text" value="hi"><button type="submit">go</button></form>' +
            '<script>document.querySelector("#m");</script>' +
            '</body></html>';
          try { __csimLoadDocument(html); } catch (_) {}
          try { __csimEvaluateXPath('//a', 0); } catch (_) {}
          try { __csimVisible(1); } catch (_) {}
          try { __csimQuery(0, '#m'); } catch (_) {}
          try { __csimQuery(0, '.b > .c'); } catch (_) {}
          try {
            const root = document.documentElement;
            if (root) {
              root.querySelectorAll('a');
              root.querySelectorAll('.b > .c, #m');
            }
          } catch (_) {}
        })();
      JS

      # `Snapshot.new(source)` is non-deterministic — V8 embeds
      # transient allocator state in the produced bytes, so the same
      # source yields different blobs across runs. V8's bytecode-cache
      # validation (`ScriptCompiler::CompileUnboundScript` with
      # `kConsumeCodeCache`) keys on snapshot bytes, so re-`new`-ing in
      # each process makes cross-process `ScriptCache` hits get
      # rejected and fall back to a SEGV-prone re-parse path. Building
      # once and persisting the dump fixes both: every process boots
      # off byte-identical snapshot bytes and `cached_data` accepts.
      def self.build_snapshot
        cache_path = snapshot_cache_path
        if cache_path
          begin
            return MiniRacerCsim::Snapshot.load(File.binread(cache_path))
          rescue StandardError
            # Fall through to rebuild; cache may be corrupt.
          end
        end
        snap = MiniRacerCsim::Snapshot.new(RuntimeShared.snapshot_src)
        # `warmup!` runs `SNAPSHOT_WARMUP` against the snapshot once
        # and rolls the resulting V8 bytecode-cache state back in, so
        # Contexts created from this snapshot inherit JIT-primed
        # versions of the hot paths above.
        snap.warmup!(SNAPSHOT_WARMUP) rescue nil
        return snap unless cache_path
        # Persist + reload so this process also boots from the same
        # bytes other processes will load — the produce-side snapshot
        # must equal the consume-side snapshot for `cached_data` to
        # accept (see the build_snapshot header rationale).
        bytes = snap.dump
        persist_snapshot_bytes(bytes, cache_path)
        MiniRacerCsim::Snapshot.load(bytes)
      end

      def self.snapshot_cache_path
        return nil if ENV['CSIM_SNAPSHOT_CACHE'].to_s.casecmp('off').zero?
        dir = ENV['CSIM_SNAPSHOT_CACHE_DIR'] ||
              File.join(ENV['HOME'] || '/tmp', '.cache', 'capybara-simulated', 'snapshot')
        sha = Digest::SHA256.hexdigest(RuntimeShared.snapshot_src + SNAPSHOT_WARMUP)
        tag = cached_data_version_tag
        File.join(dir, "#{tag}-#{sha[0, 16]}.bin")
      end

      def self.persist_snapshot_bytes(bytes, path)
        FileUtils.mkdir_p(File.dirname(path))
        tmp = "#{path}.#{Process.pid}.tmp"
        File.binwrite(tmp, bytes)
        File.rename(tmp, path)
      rescue StandardError
        # Best-effort: snapshot rebuild on every process is fine,
        # we just lose the cross-process startup savings.
      end

      # Maintain a small pool of warmed-up Contexts per Browser. Each
      # entry is post-snapshot, post-attach_host_fns — checkout is just
      # `pool.pop`. Background thread refills after each checkout so
      # the pool stays full while tests run sequentially. Pool size 1
      # would be enough for strictly serial visits, but 2 absorbs the
      # case where `refill` is still building when the next visit
      # arrives (form submit → redirect → another navigate, back-to-back).
      POOL_SIZE = 2

      def initialize(browser)
        @browser     = browser
        @ctx         = nil
        @pool        = Queue.new
        @pool_lock   = Mutex.new
        @refill_busy = false
        # Every Context is built from the base snapshot (bridge +
        # vendor bundle). Library scripts (`<script src>`) get evaluated
        # per-visit just like a real browser does on page navigation.
        # Pre-evaluating libraries into the snapshot heap is not safe:
        # jQuery's `readyList` Callbacks queue would carry `$(handler)`
        # registrations from a prior page's scripts, and a single
        # throwing handler (e.g. touching a DOM node that only existed
        # on the prior page) aborts iteration mid-fire and silently
        # drops every later callback — including the current page's.
        @snapshot = self.class.snapshot
        # Decide the warm-compile path once at construction (CLAUDE.md rule 3:
        # cache env-var decisions, don't re-read them on the per-visit /
        # per-module hot paths). `@compiled_module_urls` tracks which URLs this
        # isolate has already compiled, for the no-cd path in `native_module_for`;
        # it persists across `reset_realm` (same isolate) and is cleared only on
        # a true rebuild (different isolate, cold compilation cache).
        @warm_compile         = WARM_COMPILE_ENABLED && self.class.reset_realm_supported?
        @module_graph         = self.class.load_module_graph_supported?
        @compiled_module_urls = {}
        refill_pool_async
      end

      def eval(code)         = ctx.eval(code.to_s)
      def call(name, *args)
        result = ctx.call(name, *args)
        ScriptCache.warm_pending!
        result
      end

      # bridge.js owns the virtual clock; Ruby still drives it because
      # Capybara's polling cadence is wall-clock-anchored. Use `call`
      # (function reference) rather than `eval` (string compile) — the
      # polling loop hits these every retry tick.
      def drain_timers(max_ms = nil)
        # The bridge's `__drainTimers`/`__runLoopStep` step iframe realms' event
        # loops themselves (timers.js `drainChildRealms`), so this one call covers
        # child frames too — no separate Ruby-side fan-out (which would
        # double-advance their clocks and fire intervals twice).
        max_ms.nil? ? ctx.call('__drainTimers') : ctx.call('__drainTimers', max_ms.to_i)
      end

      # One event-loop step (task → microtask-checkpoint → render). Returns the
      # `{ 'fired', 'gen', 'dirtied' }` hash — `dirtied` (settleGen changed during
      # the step) is the authoritative find-cache-invalidation signal, since a
      # render-phase rAF / microtask-delivered MutationObserver can mutate the DOM
      # without firing a timer (fired == 0).
      def run_loop_step(max_ms, max_iter = 10_000, yield_on_gen: false)
        # `__runLoopStep` steps child iframe realms itself (timers.js
        # `drainChildRealms`), folding their fired/dirtied into the result.
        r = ctx.call('__runLoopStep', max_ms.to_i, max_iter.to_i, !!yield_on_gen)
        r.is_a?(Hash) ? r : { 'fired' => 0, 'gen' => 0, 'dirtied' => false }
      end

      # Per-iframe realms (mini_racer-csim Context#create_realm): a separate V8
      # realm — own global + intrinsics (Function/Error/DOMParser/onerror) — per
      # nested browsing context, so cross-realm tests behave per spec. Keyed by
      # realm id; dropped on every ctx rebuild (the realms die with the isolate).
      def frame_realms = (@frame_realms ||= {})

      def dispose_frame_realms
        return if @frame_realms.nil?
        @frame_realms.each_value {|fr| fr.dispose rescue nil }
        @frame_realms.clear
      end

      # mini_racer drains microtasks at every `eval` boundary, so an
      # empty `eval('0')` is the cheapest way to advance one round of
      # chained `await`/`.then` queues. `settle` calls this in a loop
      # to give the JS side a chance to drain before we tick real time.
      def drain_microtasks(iters = 4)
        i = iters.to_i
        return if i <= 0
        c = ctx
        i.times { c.eval('0') }
      end

      def settle_gen
        ctx.call('__settleGenGet').to_i
      end

      def has_ready_timer?
        return false if @ctx.nil?
        !!ctx.call('__hasReadyTimer')
      end

      # Delay (ms) until the nearest scheduled timer relative to the virtual
      # clock, or -1 if none. Drives the horizon-gated fast-forward in
      # `Browser#tick_real_time`.
      def next_timer_delay_ms
        return -1 if @ctx.nil?
        ctx.call('__nextTimerDelay').to_i
      end

      def reset_timers
        return if @ctx.nil?
        ctx.call('__resetTimers')
      end

      # Tears down the current Context and brings up a fresh one from
      # the warm snapshot. Partial in-Context resets are not safe (see
      # feedback_visit_always_rebuilds memory): library init guards
      # stick, delegate registrations leak between visits. The snapshot
      # warmup keeps the per-rebuild cost ~3 ms; jQuery / app-bundle
      # re-eval dominates after that.
      def rebuild_ctx
        # Drop the previous page's iframe realms (a new visit = new nested
        # browsing contexts). Safe here — we're between visits, not mid-callback.
        dispose_frame_realms
        # Warm path: swap the realm on the existing isolate instead of
        # disposing it and checking out a fresh one. Keeps the compilation
        # cache + builtin code warm. The host fns rebind and the snapshot
        # replays automatically; we only re-seed the post-snapshot JS-eval
        # state and drop the now-stale realm-bound Module handles (their
        # Context object_id is unchanged, so `native_module_handles` wouldn't
        # otherwise invalidate them). A failure leaves the previous realm
        # intact (mini_racer commits the new realm atomically), so fall
        # through to a full rebuild.
        if @ctx && use_warm_compile?
          begin
            @ctx.reset_realm
            @native_module_handles     = nil
            @native_module_handles_ctx = nil
            reseed_realm_js(@ctx)
            return @ctx
          rescue StandardError => e
            @browser.log_console('warn', "warm-compile reset_realm failed, falling back to full rebuild: #{e.message}")
          end
        end
        old = @ctx
        @ctx = nil
        # A true rebuild checks out a *different* isolate, whose in-memory
        # compilation cache is cold — drop the no-cd tracking so the next
        # visit goes back through the on-disk bytecode-cache path.
        @compiled_module_urls.clear
        # Hand the old Context off to a disposal thread so the next
        # visit doesn't wait on V8 teardown. Dispose order doesn't
        # matter — handles + listeners die with the Context.
        if old
          @@live_lock.synchronize { @@live.delete(old) }
          Thread.new { begin
            old.stop rescue nil
            old.dispose
          rescue StandardError
          end }
        end
        @ctx = checkout_ctx
        refill_pool_async
        @ctx
      end

      # Capybara calls `Driver#reset!` between tests; Browser delegates
      # here. With per-visit rebuild already running, the inter-test
      # path is the same operation.
      def reset_page = rebuild_ctx

      def ctx
        @ctx ||= begin
          c = checkout_ctx
          refill_pool_async
          c
        end
      end

      # Pulls a warm Context from the pool; if the pool is empty
      # (first call, or refill thread hasn't caught up) builds one
      # synchronously and registers it in `@@live` so at_exit cleanup
      # still sees it. Pool entries are pre-registered in `@@live` at
      # refill time, so the pool path doesn't double-register.
      def checkout_ctx
        @pool.pop(true)
      rescue ThreadError
        c = build_ctx
        @@live_lock.synchronize { @@live << c }
        c
      end

      # Per-call wall-clock cap (ms). Off by default — mini_racer's
      # timeout watchdog routes every eval/call through a pipe-based
      # rendezvous Thread that subtly shifts async timing and made
      # `importmap_spec` ESM-load tests flake. Opt in via
      # `CSIM_V8_CALL_TIMEOUT_MS=30000` for long-running suites where
      # an occasional JS-side infinite loop would otherwise stall the
      # whole run; the timeout converts the hang into a
      # `MiniRacerCsim::ScriptTerminatedError` on that one example.
      CALL_TIMEOUT_MS = (ENV['CSIM_V8_CALL_TIMEOUT_MS'] || '0').to_i

      # mini_racer's opt-in host namespace (ursm fork c2dd72d+):
      # `Context.new(host_namespace: 'MiniRacer')` installs
      # `globalThis.MiniRacer.drainMicrotasks()` — a native, rendezvous-free
      # microtask checkpoint (MicrotasksScope::PerformCheckpoint, no Locker,
      # termination left active). We point `__csim_yield` at it so dispatch.js's
      # per-listener checkpoint (and the event-loop microcheck) run inline on the
      # isolate thread instead of a double cross-thread round-trip. Feature-detected
      # so older fork SHAs (no kwarg) still load → they fall back to the attached
      # Context#perform_microtask_checkpoint.
      HOST_NAMESPACE_NAME = 'MiniRacer'
      # Behaviour-probe once (memoised): mini_racer's `initialize` is a `*args`
      # splat so the kwarg isn't introspectable — build one throwaway default
      # Context with the kwarg and confirm the namespace + method actually
      # installed. Old fork SHAs raise on the unknown kwarg → false → fallback.
      def self.host_namespace_supported?
        return @host_namespace_supported if defined?(@host_namespace_supported)
        @host_namespace_supported =
          begin
            MiniRacerCsim::Context.new(host_namespace: HOST_NAMESPACE_NAME)
              .eval("typeof globalThis.#{HOST_NAMESPACE_NAME} === 'object' && typeof globalThis.#{HOST_NAMESPACE_NAME}.drainMicrotasks === 'function'") == true
          rescue StandardError
            false
          end
      end

      # Warm-compile: instead of disposing the Context and checking out a
      # fresh isolate on every visit, swap only the JS *realm* on the warm
      # isolate (`reset_realm`). The isolate-level compilation cache + builtin
      # machine code survive, so a re-visited page skips cold module compile /
      # bytecode deserialize and re-tiers JIT faster. Closes the per-navigation
      # warmth gap with a real browser (which reuses one isolate and swaps the
      # realm per navigation). On by default — measured a net win across the app
      # suites (multi-visit apps ~30% under real Chrome, SPAs at parity; per-app
      # cold→warm gain 3–11%, biggest on the server-rendered Redmine whose many
      # full visits each re-compile). Set `CSIM_WARM_COMPILE=0` to opt out.
      # Requires the ursm mini_racer fork's `Context#reset_realm` —
      # `reset_realm_supported?` probes it and falls back to the cold per-visit
      # rebuild on stock mini_racer / QuickJS, so default-on is safe everywhere.
      WARM_COMPILE_ENABLED = ENV['CSIM_WARM_COMPILE'] != '0'

      # Batched ES-module graph loading (ursm mini_racer fork's
      # `Context#load_module_graph`): instead of a compile_module + instantiate
      # round-trip per module (~2·N Ruby↔V8 rendezvous for an N-module graph),
      # walk the whole graph reachable from the entry on the V8 thread and invoke
      # `resolve:` / `fetch_batch:` once per graph *level*. The fork persists the
      # callbacks + a Context-lifetime URL→Module registry, so a later
      # `import()` reuses the same Module instance for an already-loaded URL
      # (identity preserved — the thing that broke the earlier spike).
      # Unconditional (~4–5 ms/visit on heavy module graphs, zero regression
      # across WPT / app suites, no failure mode) — gated only by
      # `load_module_graph_supported?`, which falls back to the per-module path
      # on builds without the fork's `Context#load_module_graph`.

      def self.load_module_graph_supported?
        return @load_module_graph_supported if defined?(@load_module_graph_supported)
        @load_module_graph_supported = MiniRacerCsim::Context.method_defined?(:load_module_graph)
      end

      # V8's bytecode-cache version tag (mini_racer exposes it when the build
      # supports `cached_data`; 0 otherwise). Keys every ScriptCache entry so a
      # V8 upgrade invalidates stale bytecode. Fixed per process → memoized.
      def self.cached_data_version_tag
        return @cached_data_version_tag if defined?(@cached_data_version_tag)
        @cached_data_version_tag = (defined?(MiniRacerCsim::V8_CACHED_DATA_VERSION_TAG) && MiniRacerCsim::V8_CACHED_DATA_VERSION_TAG) || 0
      end

      # Behaviour-probe `reset_realm` the same way as host_namespace: the method
      # exists on the shared mixin even on the QuickJS backend (it raises
      # NotImplementedError there), so a `respond_to?` check isn't enough —
      # build a throwaway Context and confirm a realm swap actually preserves
      # an attached host fn while wiping JS-eval state.
      def self.reset_realm_supported?
        return @reset_realm_supported if defined?(@reset_realm_supported)
        @reset_realm_supported =
          begin
            c = MiniRacerCsim::Context.new
            c.attach('__csim_probe', -> { 1 })
            c.eval('globalThis.__csim_probe_marker = 1;')
            c.reset_realm
            c.eval('typeof __csim_probe === "function" && typeof globalThis.__csim_probe_marker === "undefined"') == true
          rescue StandardError
            false
          ensure
            c&.dispose
          end
      end

      # Resolved once in `initialize`; the per-visit / per-module hot paths read
      # the `@warm_compile` ivar directly.
      def use_warm_compile? = @warm_compile

      def build_ctx
        opts = { snapshot: @snapshot || self.class.snapshot }
        opts[:timeout] = CALL_TIMEOUT_MS if CALL_TIMEOUT_MS > 0
        opts[:host_namespace] = HOST_NAMESPACE_NAME if self.class.host_namespace_supported?
        c = MiniRacerCsim::Context.new(**opts)
        attach_host_fns(c)
        c.eval('__csim_installWorker();')
        c
      end

      # Under warm-compile the steady-state visit path reuses the one warm
      # isolate (reset_realm) and never checks out of the pool; a checkout only
      # happens on the initial build or the rare reset_realm-failure fallback.
      # Keep a single spare warm so that fallback pops a pre-built isolate
      # instantly instead of paying a synchronous `build_ctx`. Cold mode keeps
      # the full POOL_SIZE for back-to-back visits.
      def effective_pool_size
        use_warm_compile? ? 1 : POOL_SIZE
      end

      def refill_pool_async
        target = effective_pool_size
        @pool_lock.synchronize {
          return if @refill_busy
          return if @pool.size >= target
          @refill_busy = true
        }
        Thread.new do
          begin
            until @pool.size >= target
              c = build_ctx
              # Track pool entries so at_exit disposes them too —
              # pool members aren't currently checked out so they
              # wouldn't otherwise reach the cleanup path.
              @@live_lock.synchronize { @@live << c }
              @pool.push(c)
            end
          ensure
            @pool_lock.synchronize { @refill_busy = false }
          end
        end
      end

      def attach_host_fns(c)
        self.class.attach_host_fns(c, @browser)
        attach_run_script_with_cache(c)
        attach_native_module_loader(c)
        attach_frame_realm_loader(c)
      end

      # The bridge calls `__csim_createFrameRealm(url, body, contentType)` (from
      # `iframe.contentWindow`'s getter) to spin up a real per-iframe realm. This
      # runs re-entrantly inside the main ctx's eval; `Context#create_realm` is
      # re-entrancy-safe in mini_racer-csim. Returns the realm id (or nil if the
      # build doesn't support realms — then the bridge keeps its same-realm
      # fallback). The bridge maps `iframe.contentWindow` to
      # `MiniRacer.realmGlobal(id)`.
      def attach_frame_realm_loader(c)
        return unless c.respond_to?(:create_realm)
        c.attach('__csim_createFrameRealm', ->(url, body, content_type) {
          RuntimeShared.safe_call { create_frame_realm(c, url, body, content_type) }
        })
        # Re-navigating an iframe (src/srcdoc reassigned) builds a fresh realm;
        # the bridge calls this to tear down the superseded one so it doesn't
        # linger in @frame_realms and get re-drained on every poll tick. Disposing
        # a non-executing child realm mid-callback is safe in mini_racer-csim.
        c.attach('__csim_disposeFrameRealm', ->(id) {
          fr = frame_realms.delete(id)
          fr.dispose rescue nil if fr
          nil
        })
      end

      # Build the iframe's realm: install the bridge (the realm boots from an
      # empty global, so eval the snapshot source — ~5 ms, the isolate's compiled
      # code is shared), re-seed the post-snapshot JS state, point it at its own
      # URL with the top frame as parent/top, then load its document (running its
      # scripts in the realm). Tracked for event-loop draining + teardown.
      def create_frame_realm(parent_ctx, url, body, content_type)
        realm = parent_ctx.create_realm
        # A snapshot-built isolate replays the whole bridge into every new realm
        # automatically, so the realm already has `document` / `DOMParser` / the
        # event loop. Re-evaling the snapshot source then redefines snapshot
        # globals (e.g. the `scrollX` accessor) and throws — re-entrantly, which
        # crashes V8. Only eval the source on the bare no-snapshot dev ctx, where
        # the realm boots empty. Host fns are inherited from the parent either way;
        # `reseed_realm_js` re-points the post-snapshot realm state (`__csim_yield`).
        has_bridge = realm.eval("typeof __csimLoadDocument === 'function'")
        realm.eval(RuntimeShared.snapshot_src) unless has_bridge
        reseed_realm_js(realm)
        # Wire parent/top to the main realm (mini_racer-csim numbers it 0). No user
        # data in this eval — only the literal realm id.
        realm.eval(<<~JS)
          if (globalThis.MiniRacer && typeof globalThis.MiniRacer.realmGlobal === 'function') {
            var __topWin = globalThis.MiniRacer.realmGlobal(0);
            globalThis.parent = __topWin; globalThis.top = __topWin;
          }
        JS
        # Pass the URL + document body as call ARGUMENTS, not interpolated into an
        # eval string: mini_racer marshals them losslessly, so arbitrary HTML /
        # control bytes survive (Ruby's String#inspect is NOT a faithful JS string
        # escaper — it mangles \a, \e, and binary bytes).
        realm.call('__csimUpdateLocation', url.to_s) unless url.to_s.empty?
        realm.call('__csimLoadDocument', body.to_s, content_type.to_s)
        frame_realms[realm.id] = realm
        realm.id
      rescue StandardError => e
        @browser.log_console('warn', "frame realm load failed: #{e.message}")
        # A realm created before the failure (load threw) is untracked — not in
        # frame_realms nor __csimChildRealmIds — so nothing would ever drain or
        # dispose it. Tear it down here (safe: it's non-executing in the rescue).
        realm.dispose rescue nil if realm
        nil
      end

      def eval_esm_module(url, inline_src = nil)
        # An inline `<script type=module>` has no fetchable URL, so it can't be a
        # graph entry — keep it on the per-module path. A `src=` entry under
        # module-graph mode loads (and instantiates + evaluates) its whole graph
        # in one batched call.
        return eval_esm_graph(url) if @module_graph && inline_src.nil?
        m = native_module_for(url, inline_src)
        return nil unless m
        instantiate_native_module(m, url)
        m.evaluate
        nil
      end

      # Load + instantiate + evaluate the entire module graph reachable from
      # `entry_url` via the fork's `load_module_graph`. `resolve:`/`fetch_batch:`
      # are batched (once per graph level) and persisted on the Context, so the
      # registry-backed `import()` path reuses the same Module instances. Returns
      # the entry's value (unused here — we evaluate for side effects).
      def eval_esm_graph(entry_url)
        c       = ctx
        browser = @browser
        version = self.class.cached_data_version_tag
        fetched = {}
        result  = c.load_module_graph(
          entry_url.to_s,
          resolve: ->(edges) {
            edges.map {|specifier, referrer| browser.resolve_module_specifier(specifier, referrer) rescue nil }
          },
          fetch_batch: ->(urls) {
            urls.map {|u|
              if (memo = module_src_get(u))
                sha, body = memo
                cached = ScriptCache.lookup(sha, version, kind: :module)
                fetched[u] = [sha, body, !cached.nil?]
                next [body, cached]
              end
              src, fresh_until = browser.module_source(u)
              next nil unless src
              body   = module_body(u, src)
              sha    = Digest::SHA256.hexdigest(body)
              cached = ScriptCache.lookup(sha, version, kind: :module)
              module_src_put(u, sha, body, fresh_until) if fresh_until
              fetched[u] = [sha, body, !cached.nil?]
              [body, cached]
            }
          }
        )
        # Warm the on-disk bytecode cache for the modules this call actually
        # compiled (already-registered URLs aren't relisted) that missed or were
        # rejected — same policy as the per-module path's `queue_warm`. Guard the
        # result shape: an empty/un-fetchable entry can yield a graph with no
        # newly-compiled modules.
        Array(result && result[:modules]).each {|mod|
          meta = fetched[mod[:url]] or next
          sha, body, had_cache = meta
          ScriptCache.queue_warm(c, sha, mod[:url], body, version, kind: :module) if !had_cache || mod[:cache_rejected]
        }
        nil
      # `MiniRacerCsim::Error` is the base of ParseError / RuntimeError and the
      # graph-load errors; catch it all so a bad module under module-graph mode
      # logs to the JS console (like the per-module path) instead of escaping to
      # `safe_call` and surfacing only as a stderr warn.
      rescue MiniRacerCsim::Error => e
        @browser.log_console('error', "module graph error in #{entry_url}: #{e.message}")
        nil
      end

      # Returns the cached `[sha, body]` for a module URL while still fresh, or
      # nil (dropping an expired entry). Cross-visit, in-process; see the
      # `@@module_src` declaration for why this is safe and header-driven.
      def module_src_get(url)
        @@module_src_lock.synchronize {
          v = @@module_src[url] or return nil
          if Time.now < v[2]
            [v[0], v[1]]
          else
            @@module_src.delete(url)
            nil
          end
        }
      end

      def module_src_put(url, sha, body, fresh_until)
        @@module_src_lock.synchronize {
          # Bound memory: real suites touch a few hundred distinct module URLs,
          # so this never trips in practice; a pathological run just re-warms.
          @@module_src.clear if @@module_src.size >= MODULE_SRC_MAX
          @@module_src[url] = [sha, body, fresh_until]
        }
      end

      # A `.json` module is exposed as the default export of its parsed value;
      # every other body is the fetched source as-is. Shared by the per-module
      # (`native_module_for`) and graph (`eval_esm_graph`) load paths so the two
      # can't drift on what counts as a JSON module.
      def module_body(url, src)
        url.to_s.match?(/\.json(?:\?|$)/) ? "export default #{src};" : src
      end

      # MiniRacerCsim::Module handles are bound to their Context; rebuild_ctx
      # invalidates them, so the cache is keyed off `@ctx.object_id` and
      # rebuilt lazily on first use after a rebuild.
      def native_module_handles
        @native_module_handles ||= {}
        if @native_module_handles_ctx != ctx.object_id
          @native_module_handles = {}
          @native_module_handles_ctx = ctx.object_id
        end
        @native_module_handles
      end

      def native_module_for(url, inline_src = nil)
        cache = native_module_handles
        return cache[url] if cache.key?(url)
        url_s = url.to_s
        src = inline_src || @browser.rack_fetch_body(url_s)
        return cache[url] = nil unless src
        body = module_body(url_s, src)
        c    = ctx
        # No-cd warm path: once this isolate has compiled a URL, its in-memory
        # compilation cache holds the bytecode keyed by source. On a re-visit
        # (same warm isolate via reset_realm) skip `cached_data` so V8 hits that
        # cache directly instead of paying the forced kConsumeCodeCache
        # deserialize. The first compile of each URL warms the on-disk bytecode
        # cache for that body; if the same URL later serves a different body
        # (non-fingerprinted / server-dynamic module) the no-cd branch recompiles
        # it correctly from source — V8's in-memory cache is keyed by source, so a
        # changed body just misses and recompiles — but won't re-warm the on-disk
        # cache for the new body. Acceptable: module URLs on this path are
        # fingerprinted-immutable. Only meaningful under warm-compile — on the
        # cold rebuild path the isolate changes, `@compiled_module_urls` is
        # cleared, and every module goes back through `cached_data`.
        warm = @warm_compile && inline_src.nil?
        if warm && @compiled_module_urls.key?(url_s)
          m = c.compile_module(body, filename: url_s)
        else
          sha     = Digest::SHA256.hexdigest(body)
          version = self.class.cached_data_version_tag
          cached  = ScriptCache.lookup(sha, version, kind: :module)
          m       = c.compile_module(body, filename: url_s, cached_data: cached)
          ScriptCache.queue_warm(c, sha, url_s, body, version, kind: :module) if cached.nil? || m.cache_rejected?
          @compiled_module_urls[url_s] = true if warm
        end
        cache[url] = m
      rescue MiniRacerCsim::ParseError => e
        @browser.log_console('error', "module parse error in #{url}: #{e.message}")
        cache[url] = nil
      end

      def instantiate_native_module(m, importer_url)
        return unless m.status == :uninstantiated
        browser = @browser
        m.instantiate do |specifier, referrer|
          resolved = browser.resolve_module_specifier(specifier, referrer || importer_url)
          child = native_module_for(resolved)
          raise "module not found: #{resolved}" unless child
          child
        end
      end

      # `import('x')` routes through this callback; mini_racer's C side
      # auto-evaluates the returned Module and drains microtasks before
      # resolving the outer Promise.
      def attach_native_module_loader(c)
        c.attach('__csim_evalEsmEntry', ->(url, inline) {
          RuntimeShared.safe_call { eval_esm_module(url, inline) }
          nil
        })
        c.dynamic_import_resolver = ->(specifier, referrer) {
          resolved = @browser.resolve_module_specifier(specifier, referrer)
          m = native_module_for(resolved)
          raise "module not found: #{resolved}" unless m
          instantiate_native_module(m, resolved)
          m
        }
      end

      # When mini_racer exposes `Context#compile` + `Script#cached_data`
      # + `Snapshot.load` (rubyjs/mini_racer#413), override the JS-side
      # `__csim_runScript` fallback with a Ruby host fn that
      # bytecode-caches each script body in a process-wide hash +
      # on-disk store. Discourse's main chunk is ~140 ms of parse +
      # JIT per visit otherwise; the cache reduces it to a deserialize
      # + run path. Worker isolates run on their own threads —
      # `compile` from the main thread against a Worker isolate is
      # unsafe — so the class-level `attach_host_fns` (used by
      # `build_worker`) intentionally skips this attach.
      # V8's bytecode cache only pays off above a body-size threshold
      # — the rendezvous round-trip + Ruby-side SHA256 + compile +
      # dispose runs ~150–300 µs, while `(0, eval)(body)` at V8
      # globalThis for a tiny script is sub-microsecond. Above the
      # threshold, V8 parse + JIT cold-path is multiple ms — worth
      # the cache. Redmine's jQuery + Stimulus inline scripts
      # (median ~400 B) dominated the regression: pre-threshold,
      # routing every snippet through Ruby blew the 122-test suite
      # from 56 s → 224 s. Threshold sweep:
      #
      #   threshold | Redmine wall
      #     1 KB    | 143 s
      #     8 KB    | 103 s
      #    32 KB    |  90 s
      #    64 KB    |  62 s  ← baseline parity
      #
      # 64 KB keeps Discourse's main Ember chunk (140 KB+) on the
      # cache path while Stimulus / Trix / etc. shorts stay on the
      # JS-only fast path. `CSIM_SCRIPT_CACHE_MIN_BYTES=0` forces
      # the cache for everything (debug / cross-process bench).
      SCRIPT_CACHE_MIN_BYTES = (ENV['CSIM_SCRIPT_CACHE_MIN_BYTES'] || '65536').to_i

      def attach_run_script_with_cache(c)
        return unless c.respond_to?(:compile)
        version_tag = self.class.cached_data_version_tag
        debug = ENV['CSIM_SCRIPT_CACHE_DEBUG']
        # Big bodies → Ruby-side bytecode cache. The dispatcher below
        # routes small bodies to a JS-only `(0, eval)` so they don't
        # pay the rendezvous round-trip.
        c.attach('__csim_runScriptCached', ->(label, body) {
          RuntimeShared.safe_call {
            # Trailing `;undefined` suppresses the script's COMPLETION VALUE so
            # `script.run`'s return crosses the V8→Ruby boundary on the trivial
            # ValueSerializer fast path. Without it, a large inline script ending
            # in a jQuery-ish expression returns a `ce.fn.init` (array-like,
            # non-cloneable) that drags through the safe_context deep-copy filter —
            # pure waste, since the value is discarded (`nil` below). The SHA keys
            # the bytecode cache on the COMPILED source, so the suffix must be
            # hashed and fed to `queue_warm` too (else cached_data is rejected).
            src    = "#{body}\n;undefined"
            sha    = Digest::SHA256.hexdigest(src)
            cached = ScriptCache.lookup(sha, version_tag)
            script = c.compile(src, filename: label.to_s, cached_data: cached)
            $stderr.puts "[runScript] label=#{label.to_s[0,60]} hit=#{!cached.nil?} rejected=#{script.cache_rejected?}" if debug
            # V8 forbids `produce_cache: true` from inside a host-fn
            # callback so we queue misses + rejects for top-level
            # produce via `ScriptCache.warm_pending!` after the
            # current `V8Runtime#call` returns.
            ScriptCache.queue_warm(c, sha, label, src, version_tag) if cached.nil? || script.cache_rejected?
            begin
              script.run
            ensure
              script.dispose
            end
          }
          nil
        })
        # Small bodies normally run JS-side via `(0, eval)(body)` — fast,
        # no Ruby↔V8 boundary. But `(0, eval)` block-scopes a script's
        # top-level `const`/`let`/`class` to the eval, so they vanish
        # instead of landing in the realm's *shared* global lexical
        # environment where a later `<script>` would see them. Real
        # browsers (and our big-body `compile().run` path above) keep
        # them. The shape that needs this is a leading lexical
        # declaration: `<script>const CFG=…</script><script>…use CFG…` and
        # every WPT helper pulled in via `// META: script=` that starts
        # `const TABLE = […]` (sab.js's `createBuffer`, encodings.js's
        # `encodings_table`, …). So route ONLY scripts whose first real
        # statement is a top-level `const`/`let`/`class` through `ctx.eval`
        # (a top-level V8 script → shared lexical env); everything else
        # (IIFEs, `var`/`function` — which already leak to globalThis
        # under `(0, eval)` — and plain calls) stays on the fast path. A
        # later `(0, eval)` script can READ those bindings from the global
        # lexical environment fine; only DEFINING them needed the
        # real-script path. No bytecode cache here — the SHA + compile +
        # dispose is the part that regressed tiny-script-heavy suites
        # (Redmine 56→224 s); plain `ctx.eval` is rendezvous-cheap, and
        # the leading-lexical gate keeps the boundary off the hot path for
        # the ~95% of inline scripts that don't lead with a declaration.
        # Limitation: a top-level `const` that is NOT the first statement
        # (after other top-level code) won't be shared — rare, and the
        # WPT helper corpus + the `<script>const CFG…` pattern both lead
        # with the declaration.
        # NOTE: do NOT wrap in `safe_call`. A JS throw from `c.eval`
        # raises MiniRacerCsim::RuntimeError, which mini_racer re-raises as a
        # JS exception at the call site — so bridge.entry.js's
        # `try { __csim_runScript(…) } catch (e)` sees it and runs its
        # normal path (console diagnostic, `_ok=false`, fire the script
        # `error` event), exactly as the old JS-side `(0, eval)` did and
        # as the QuickJS runner does. Swallowing here would turn a
        # throwing leading-`const` inline script into a silent `load`.
        c.attach('__csim_runScriptEval', ->(label, body) {
          # Trailing `;undefined` makes the script's COMPLETION VALUE undefined so
          # `c.eval`'s return crosses the V8→Ruby boundary on the trivial
          # ValueSerializer fast path. Without it, a leading-lexical inline script
          # ending in a jQuery-ish expression (`const cfg=…; $(…)`) returns a
          # `ce.fn.init` (array-like, non-cloneable) here, which falls into the
          # safe_context deep-copy filter slow-path — pure waste, since the value
          # is discarded (`nil` below). The `//# sourceURL` line is a comment and
          # doesn't affect the completion value; lexical declarations persist as a
          # side effect of eval, independent of the completion value.
          c.eval("#{body}\n;undefined\n//# sourceURL=#{label.to_s.tr("\n", ' ')}")
          nil
        })
        install_run_script_dispatcher(c)
      end

      # The JS-side `__csim_runScript` dispatcher routes each inline-script body
      # to the bytecode-cache path, the shared-lexical `ctx.eval` path, or the
      # JS-only `(0, eval)` fast path. It is realm state (`globalThis.…`), so it
      # is wiped by `reset_realm` and must be re-seeded on the warm-compile path
      # (see `reseed_realm_js`). Split out from `attach_run_script_with_cache`
      # for that reuse; the host-fn attaches above are auto-rebound by
      # `reset_realm` and don't need re-running.
      def install_run_script_dispatcher(c)
        return unless c.respond_to?(:compile)
        c.eval(<<~JS)
          (function () {
            const cached    = globalThis.__csim_runScriptCached;
            const runEval   = globalThis.__csim_runScriptEval;
            const threshold = #{SCRIPT_CACHE_MIN_BYTES};
            // Leading top-level lexical declaration, after optional BOM /
            // whitespace / line+block comments / a "use strict" prologue.
            const LEADS_LEXICAL = /^[\\s\\uFEFF]*(?:(?:\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)\\s*)*(?:["']use strict["'];?\\s*)?(?:export\\s+)?(?:const|let|class)[\\s{\\[]/;
            globalThis.__csim_runScript = function (label, body) {
              if (body.length >= threshold) return cached(label, body);
              if (LEADS_LEXICAL.test(body)) return runEval(label || 'csim-eval', body);
              (0, eval)(body + '\\n//# sourceURL=' + (label || 'csim-eval'));
            };
          })();
        JS
      end

      # After `reset_realm` swaps the JS realm on the warm isolate, the host-fn
      # callbacks are auto-rebound and the snapshot (bridge.js) is re-replayed,
      # but every `globalThis.…` assignment csim ran *post-snapshot* in
      # `build_ctx` is gone (realm state). Re-seed exactly those three:
      #   1. the `__csim_yield` alias to the native microtask checkpoint,
      #   2. the `__csim_runScript` dispatcher,
      #   3. the `__csim_installWorker()` post-snapshot init call.
      # All other construction work (BROWSER/STDLIB host fns, the module loader,
      # `dynamic_import_resolver`) survives the realm swap. Verified empirically:
      # host fns rebind, snapshot globals replay, the C-side import resolver
      # persists — only `c.eval`-installed realm state is wiped.
      def reseed_realm_js(c)
        # Only the host_namespace branch installs `__csim_yield` as a JS alias
        # (`globalThis.__csim_yield = MiniRacer.drainMicrotasks`); the fallback
        # branches `c.attach` it, and those survive the realm swap. So re-seed
        # the alias exactly when the namespace is in use — install_realm
        # re-installs `globalThis.MiniRacer`, so the alias just needs re-pointing.
        if self.class.host_namespace_supported?
          c.eval("globalThis.__csim_yield = globalThis.#{HOST_NAMESPACE_NAME}.drainMicrotasks;")
        end
        install_run_script_dispatcher(c)
        c.eval('__csim_installWorker();')
      end

      # Class-level attach so Worker isolates (Ruby-thread-owned
      # Contexts that don't have a Runtime instance wrapping them)
      # reuse the same `BROWSER_HOST_FNS` + `STDLIB_HOST_FNS` table
      # the main runtime wires up.
      def self.attach_host_fns(c, browser)
        RuntimeShared::BROWSER_HOST_FNS.each {|name, body|
          c.attach(name, ->(*a) { RuntimeShared.safe_call { body.call(browser, *a) } })
        }
        RuntimeShared::STDLIB_HOST_FNS.each {|name, body|
          c.attach(name, body)
        }
        # `dispatchEventForUserAction` calls this between listener
        # invocations to match HTML spec "clean up after running
        # script" microtask-checkpoint semantics. Older mini_racer
        # without rubyjs/mini_racer#418 falls back to a no-op, leaving
        # dispatch correct but losing the listener-interleaved
        # Backburner-style autorun drains.
        # Prefer the native in-isolate checkpoint (mini_racer host_namespace):
        # alias `__csim_yield` to `globalThis.MiniRacer.drainMicrotasks` JS-side,
        # so callers pay ~sub-µs instead of the attached-fn double cross-thread
        # round-trip. Fall back to the attached Context#perform_microtask_checkpoint
        # ('M' rendezvous) on older fork SHAs, or a no-op.
        if c.eval("typeof globalThis.#{HOST_NAMESPACE_NAME} === 'object' && globalThis.#{HOST_NAMESPACE_NAME} !== null && typeof globalThis.#{HOST_NAMESPACE_NAME}.drainMicrotasks === 'function'")
          c.eval("globalThis.__csim_yield = globalThis.#{HOST_NAMESPACE_NAME}.drainMicrotasks;")
        elsif c.respond_to?(:perform_microtask_checkpoint)
          c.attach('__csim_yield', -> { c.perform_microtask_checkpoint; nil })
        else
          c.attach('__csim_yield', -> { nil })
        end
      end

      # Worker-isolate factory: fresh Context from the shared
      # snapshot, host fns attached, `__csim_isWorker` flag set, +
      # the per-worker postMessage host fn closed over `post_back`.
      # Returns a uniform `WorkerRuntime` adapter that
      # `Browser#run_worker` drives.
      def self.build_worker(browser, post_back)
        wopts = { snapshot: snapshot }
        wopts[:host_namespace] = HOST_NAMESPACE_NAME if host_namespace_supported?
        ctx = MiniRacerCsim::Context.new(**wopts)
        attach_host_fns(ctx, browser)
        ctx.attach('__csim_workerPostMessage', ->(data) { post_back.call(data); nil })
        # Worker's timer table is independent from main's; routing the
        # worker's `setTimersActive` through `browser.timers_active=`
        # races the main isolate's polling? gate, dropping main-thread
        # pending XHRs the moment the worker's queue empties. The settle
        # loop already polls `worker_pending?` for worker thread activity.
        ctx.attach('__setTimersActive', ->(_flag) { nil })
        ctx.eval('__csim_installWorkerScope();')
        WorkerRuntime.new(
          eval_fn:           ->(s)     { ctx.eval(s.to_s) },
          call_fn:           ->(n, *a) { ctx.call(n.to_s, *a) },
          drain_microtasks:  ->        { ctx.eval('0') },
          drain_timers:      ->        { ctx.call('__drainTimers', 50) },
          has_ready_timer:   ->        { !!ctx.call('__hasReadyTimer') },
          dispose:           ->        { ctx.dispose rescue nil }
        )
      end
    end
  end
end
