# frozen_string_literal: true

# V8 runtime on rusty_racer. The DOM lives in JS; this class owns the
# V8 isolate/context pair, the warm snapshot, the host-fn callbacks the
# bridge reaches back through, and the per-visit `rebuild_ctx` dance.
#
# `QuickJSRuntime` is the alternate implementation; both expose the same
# surface (`eval` / `call` / `drain_timers` / `drain_microtasks` /
# `settle_gen` / `has_ready_timer?` / `reset_timers` / `rebuild_ctx` /
# `reset_page`). Browser picks one at construction.

require 'digest'
require 'fileutils'
require 'rusty_racer'

require_relative 'runtime_shared'
require_relative 'script_cache'
require_relative 'worker_runtime'


begin
  stack_kb = (ENV['CSIM_V8_STACK_KB'] || '2000').to_i
  RustyRacer::Platform.set_flags!(stack_size: stack_kb)
  # Default V8 old-space cap is ~1.4 GB, which OOMs on workloads that
  # marshal large pixel buffers across postMessage (Discourse's
  # media-optimization-worker hands a 317 MB raw RGBA frame from an
  # 8900×8900 fixture through the transfer-buffer path). Match
  # Discourse's own testem flag of 4 GB so the test fits.
  #
  # rusty_racer >= 0.1.4 installs a near-heap-limit callback on every isolate,
  # so EXCEEDING this cap raises a catchable `RustyRacer::V8OutOfMemoryError`
  # (and the isolate recovers) instead of V8 aborting the whole process with a
  # fatal "Reached heap limit". So this value doubles as the memory backstop: a
  # runaway script fails one example, it doesn't kill the run. No per-isolate
  # `memory_limit` needed — the default protection catches at the cap.
  max_old_mb = (ENV['CSIM_V8_MAX_OLD_SPACE_MB'] || '4096').to_i
  RustyRacer::Platform.set_flags!('max-old-space-size': max_old_mb) if max_old_mb > 0
  # `CSIM_V8_PROF=1` turns on V8's tick-sampling profiler. Output
  # lands in `isolate-*-v8.log`; process with:
  #   node --prof-process isolate-*-v8.log > prof.txt
  # (Standard Node distribution ships the post-processor; no extra
  # install needed.) The log is per-isolate, and warm-compile keeps one
  # isolate for the whole run, so expect a single aggregate log.
  if ENV['CSIM_V8_PROF'] == '1'
    RustyRacer::Platform.set_flags!(:prof, 'logfile-per-isolate': nil)
  end
  # `CSIM_V8_FLAGS` passes arbitrary V8 flags through to
  # `set_flags_from_string` for perf experiments (JIT tier-up tuning,
  # GC, lite-mode). Whitespace-separated; each token is `--`-prefixed by
  # rusty's `set_flags!`, so write them WITHOUT the leading dashes:
  #   CSIM_V8_FLAGS='jitless'                 -> --jitless
  #   CSIM_V8_FLAGS='sparkplug no-turbofan'   -> --sparkplug --no-turbofan
  #   CSIM_V8_FLAGS='max-opt=1'               -> --max-opt=1
  # Flags may interact with the cached snapshot's compiled-code state, so
  # pair a sweep with `CSIM_SNAPSHOT_CACHE=off`.
  if (raw = ENV['CSIM_V8_FLAGS'].to_s.strip) && !raw.empty?
    flags = raw.split(/\s+/).map {|f| f.sub(/\A--/, '') }
    RustyRacer::Platform.set_flags!(*flags)
  end
rescue RustyRacer::PlatformAlreadyInitialized
end

module Capybara
  module Simulated
    class V8Runtime

      @@snapshot_lock = Mutex.new
      @@snapshot      = nil
      @@live_lock     = Mutex.new
      @@live          = []

      at_exit do
        @@live_lock.synchronize {
          @@live.each {|c|
            begin
              c.terminate rescue nil
              c.dispose
            rescue StandardError
            end
          }
          @@live.clear
        }
      end

      # The host namespace rusty_racer installs into every context (main and
      # per-frame): `globalThis.RustyRacer.drainMicrotasks()` (a native,
      # rendezvous-free microtask checkpoint), `contextGlobal(id)` /
      # `contextOf(value)` (the per-frame realm machinery), and
      # `setPromiseRejectHandler`. The bridge JS hard-codes the same
      # `globalThis.RustyRacer` literal (timers.js / platform-globals.js /
      # unhandled-rejection.js / bridge.entry.js) — a rename must touch both
      # sides.
      HOST_NAMESPACE_NAME = 'RustyRacer'

      # One isolate + its default context, presented as a single handle — the
      # shape the rest of the runtime (and `ScriptCache`) passes around.
      # rusty splits the VM into an `Isolate` (lifecycle / realms / microtasks /
      # terminate) and the `Context`s it hands out (eval / call / attach /
      # compile / reset); this class pairs them and replays recorded host-fn
      # attaches onto per-frame realm contexts (rusty's attach is per-context).
      class Ctx
        def initialize(snapshot: nil, timeout: 0)
          @iso        = RustyRacer::Isolate.new(host_namespace: HOST_NAMESPACE_NAME,
                                                snapshot:       snapshot,
                                                timeout_ms:     timeout.to_i)
          @ctx        = @iso.context
          @attached   = []
          @generation = 0
          # rusty's heap-accounting API (heap_statistics / low_memory_notification)
          # landed in 0.1.9. Probe the real Isolate once here — the Ctx wrapper
          # delegates these unconditionally, so a `respond_to?` on the wrapper
          # would always be true and never gate the version. Cached so the
          # per-visit pressure check (rule 3) is an ivar read, not a dispatch.
          @heap_accounting = @iso.respond_to?(:heap_statistics)
        end

        # True iff the underlying rusty Isolate exposes the 0.1.9 heap-accounting
        # API. Drives `relieve_heap_pressure`'s version gate.
        def heap_accounting? = @heap_accounting

        # ── Context surface ─────────────────────────────────────────
        # rusty drains microtasks at call-depth zero (V8's default kAuto
        # policy), so a returned eval/call has already run its end-of-script
        # microtasks.
        def eval(src)          = @ctx.eval(src)
        def call(name, *args)  = @ctx.call(name, *args)

        # Record every attach so `create_context` can replay them: the bridge
        # in a per-frame realm reaches the same Ruby host fns as the main
        # context, but rusty's attach is per-context.
        def attach(name, prc)
          @attached << [name, prc]
          @ctx.attach(name, prc)
        end

        # One rendezvous for the whole host-fn table (vs one per fn).
        def attach_many(fns)
          @attached.concat(fns.to_a)
          @ctx.attach_many(fns)
        end

        # Bumped on every realm reset: realm-bound caches (module handles)
        # key off `[object_id, generation]` so invalidation is intrinsic to
        # reset — the Ctx OBJECT survives a warm reset, so object_id alone
        # can't detect one.
        attr_reader :generation

        # Swap the realm for a snapshot-fresh one on the warm isolate. Per
        # rusty's contract the host fns die with the old context — drop the
        # replay record so the caller's re-attach doesn't accumulate stale
        # entries visit over visit.
        def reset
          @ctx.reset
          @attached.clear
          @generation += 1
        end

        def compile(src, **kw)        = @ctx.compile(src, **kw)
        def compile_module(src, **kw) = @ctx.compile_module(src, **kw)

        # ── Isolate surface ─────────────────────────────────────────
        def terminate                        = @iso.terminate
        def dispose                          = @iso.dispose
        def perform_microtask_checkpoint     = @iso.perform_microtask_checkpoint
        # rusty >= 0.1.9: V8 heap accounting + a forced full GC. Used by the
        # per-visit heap-pressure relief in `rebuild_ctx` (see there).
        def heap_statistics                  = @iso.heap_statistics
        def low_memory_notification          = @iso.low_memory_notification

        def dynamic_import_resolver=(prc)
          @iso.dynamic_import_resolver = prc
        end

        # A per-iframe realm: a fresh context in the SAME isolate (shared heap,
        # own global + intrinsics). Carries `.id` / eval / call / dispose — the
        # rest of the surface `create_frame_realm` needs.
        #
        # `to_h` dedups re-attached names to their latest proc, matching
        # attach's override semantics. NOTE: context-bound fns
        # (`__csim_runScript*`, `__csim_evalEsmEntry`) get realm-bound
        # overrides in `create_frame_realm` after this replay.
        def create_context
          realm = @iso.create_context
          realm.attach_many(@attached.to_h)
          realm
        end
      end

      def self.snapshot
        @@snapshot_lock.synchronize { @@snapshot ||= build_snapshot }
      end

      # Pre-warm script: exercises the JS surfaces that get JIT-compiled
      # on every page load (HTML parse, selector tokenise + match, event
      # dispatch, style-decl parse, cascade resolve). Runs once at
      # snapshot creation; the resulting compiled-code state ships in
      # the snapshot so each new context starts with these paths warm.
      # (`Snapshot#warmup!` follows the V8 WarmUpSnapshotDataBlob contract:
      # the warmup runs in a throwaway context — only code, no heap state,
      # survives into the blob.)
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
      # rejected. Building once and persisting the dump fixes that:
      # every process boots off byte-identical snapshot bytes and
      # `cached_data` accepts.
      def self.build_snapshot
        cache_path = snapshot_cache_path
        return build_snapshot_uncached unless cache_path
        begin
          FileUtils.mkdir_p(File.dirname(cache_path))
          # Serialize concurrent cold boots (parallel test workers):
          # `Snapshot.new` is non-deterministic, so two processes racing the
          # build would persist different bytes and every ScriptCache entry
          # keyed to the loser's blob gets `cache_rejected` forever after.
          # One process builds under the lock; the rest load its bytes.
          File.open("#{cache_path}.lock", File::CREAT | File::RDWR) do |lock|
            lock.flock(File::LOCK_EX)
            if (bytes = read_verified_snapshot(cache_path))
              return RustyRacer::Snapshot.load(bytes)
            end
            snap  = build_snapshot_uncached
            # Persist + reload so this process also boots from the same
            # bytes other processes will load — the produce-side snapshot
            # must equal the consume-side snapshot for `cached_data` to
            # accept (see the build_snapshot header rationale).
            bytes = snap.dump
            persist_snapshot_bytes(bytes, cache_path)
            return RustyRacer::Snapshot.load(bytes)
          end
        rescue StandardError
          # Cache plumbing must never break boot; fall back to an
          # in-process build (we just lose the cross-process savings).
          build_snapshot_uncached
        end
      end

      def self.build_snapshot_uncached
        snap = RustyRacer::Snapshot.new(RuntimeShared.snapshot_src)
        # `warmup!` runs `SNAPSHOT_WARMUP` once in a throwaway context and
        # keeps the resulting compiled code, so contexts created from this
        # snapshot inherit JIT-primed versions of the hot paths above.
        snap.warmup!(SNAPSHOT_WARMUP) rescue nil
        snap
      end

      # `Snapshot.load` doesn't validate — corrupt bytes surface as a V8
      # FATAL abort at the first `Isolate.new`, long past any rescue here.
      # Verify against the SHA sidecar written at persist time, so a
      # truncated / corrupted blob rebuilds instead of crash-looping every
      # subsequent run.
      def self.read_verified_snapshot(path)
        return nil unless File.exist?(path)
        bytes = File.binread(path)
        sha   = File.read("#{path}.sha256").strip
        Digest::SHA256.hexdigest(bytes) == sha ? bytes : nil
      rescue StandardError
        nil
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
        tmp = "#{path}.#{Process.pid}.tmp"
        File.binwrite(tmp, bytes)
        File.write("#{path}.sha256", Digest::SHA256.hexdigest(bytes))
        File.rename(tmp, path)
        prune_snapshot_cache(path)
      rescue StandardError
        # Best-effort: snapshot rebuild on every process is fine,
        # we just lose the cross-process startup savings.
      end

      # A multi-MB blob per bridge edit / V8 upgrade accrues forever
      # otherwise; only the current key is ever loadable again, so drop
      # the rest.
      def self.prune_snapshot_cache(current)
        keep = File.basename(current)
        Dir.glob(File.join(File.dirname(current), '*.bin')).each do |f|
          next if File.basename(f) == keep
          FileUtils.rm_f([f, "#{f}.sha256", "#{f}.lock"])
        end
      rescue StandardError
      end

      def initialize(browser)
        @browser = browser
        @ctx     = nil
        # Every context is built from the base snapshot (bridge +
        # vendor bundle). Library scripts (`<script src>`) get evaluated
        # per-visit just like a real browser does on page navigation.
        # Pre-evaluating libraries into the snapshot heap is not safe:
        # jQuery's `readyList` Callbacks queue would carry `$(handler)`
        # registrations from a prior page's scripts, and a single
        # throwing handler (e.g. touching a DOM node that only existed
        # on the prior page) aborts iteration mid-fire and silently
        # drops every later callback — including the current page's.
        @snapshot = self.class.snapshot
        # `@compiled_module_urls` / `@compiled_script_keys` track what this
        # isolate has already compiled, for the no-cd paths in
        # `native_module_for` / `attach_run_script_with_cache`. They persist
        # across warm realm resets (same isolate, warm in-memory compilation
        # cache) and are cleared only on a true rebuild (different isolate,
        # cold cache).
        @compiled_module_urls = {}
        @compiled_script_keys = {}
      end

      def eval(code)         = ctx.eval(code.to_s)
      def call(name, *args)
        result = ctx.call(name, *args)
        ScriptCache.warm_pending!
        result
      end

      # Route a host-fn call into a specific frame realm's context — or the
      # main context when `realm_id` is nil/0. Each frame realm is a full
      # bridge with its OWN handle registry + `document`, so a node / query
      # op on a frame node (a `within_frame` body) must execute in that
      # realm; running it in the main context would dereference the handle
      # against the wrong registry. Callers (`Browser#dom_call`) gate on
      # `frame_realm_alive?` first, so a disposed realm surfaces as a stale
      # element rather than silently mis-resolving against the main registry.
      def realm_call(realm_id, name, *args)
        return call(name, *args) if realm_id.nil? || realm_id.zero?
        fr = frame_realms[realm_id]
        return call(name, *args) unless fr
        result = fr.call(name, *args)
        ScriptCache.warm_pending!
        result
      end

      # Is `realm_id` a live frame realm? A frame removed / re-navigated
      # mid-block disposes its realm (`__csim_disposeFrameRealm`) while the
      # Browser's `@current_realm_id` may still point at it; the Browser uses
      # this to raise a stale-element instead of running a frame handle op
      # against the main registry.
      def frame_realm_alive?(realm_id)
        !(realm_id.nil? || realm_id.zero?) && frame_realms.key?(realm_id)
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

      # Per-iframe realms (`Isolate#create_context`): a separate V8 context —
      # own global + intrinsics (Function/Error/DOMParser/onerror) — per
      # nested browsing context, so cross-realm tests behave per spec. Keyed
      # by context id; released explicitly by `dispose_frame_realms` on every
      # rebuild — under warm-compile the isolate survives the visit, so
      # nothing else would ever free them.
      def frame_realms = (@frame_realms ||= {})

      def dispose_frame_realms
        @realm_module_handles&.clear
        @frame_realm_depths&.clear
        return if @frame_realms.nil?
        @frame_realms.each_value {|fr| fr.dispose rescue nil }
        @frame_realms.clear
      end

      # Frame-scoped navigation: tear down the realm `old_id` and build a fresh
      # one for the same `<iframe>` from the just-fetched document, returning the
      # new realm's context id. A new context (not an in-place document reset) is
      # the right model — it drops the prior frame document's timers / listeners
      # / module state, exactly like the main page's per-visit rebuild. `parent_id`
      # keeps the new realm's `parent`/`top` wired to the owning realm. The
      # Browser then re-points the iframe element at the new id (`__csimRebindFrameRealm`).
      def reload_frame_realm(old_id, parent_id, url, body, content_type)
        dispose_frame_realm(old_id)
        create_frame_realm(ctx, url, body, content_type, parent_id)
      end

      # Tear down a single frame realm (e.g. a descendant frame destroyed when an
      # ancestor frame re-navigates). No-op for nil/0/unknown ids.
      def dispose_frame_realm(id)
        return if id.nil? || id.zero?
        # The frame's browsing context is going away — revoke the blob URLs it
        # created (url-lifetime "Removing an iframe").
        @browser.revoke_realm_blobs(id) rescue nil
        @realm_module_handles&.delete(id)
        @frame_realm_depths&.delete(id)
        fr = frame_realms.delete(id)
        fr.dispose rescue nil if fr
        nil
      end

      # One native microtask checkpoint — a checkpoint runs the queue until
      # empty, and rusty already performs one at the end of every top-level
      # eval/call (V8's default kAuto policy), so a single explicit checkpoint
      # is all `settle` needs to advance chained `await`/`.then` queues
      # between ticks.
      def drain_microtasks
        @ctx&.perform_microtask_checkpoint
      end

      # Raw bytes pass through as-is: rusty marshals tag-driven — a
      # BINARY-encoded Ruby String crosses as a JS Uint8Array (and
      # Uint8Array/ArrayBuffer args come back as BINARY Strings) — one copy,
      # no base64 / latin1 string inflation. `transfer_buffer_fetch` already
      # returns ASCII-8BIT-tagged bytes.
      def wrap_binary(bytes)
        bytes
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

      # Brings up a snapshot-fresh realm for the next page via the warm path:
      # `Context#reset` swaps in a brand-new global on the long-lived isolate —
      # a FULL fresh realm, not a partial in-context reset (those are unsafe per
      # feedback_visit_always_rebuilds: library init guards stick, delegates
      # leak) — keeping the isolate's in-memory compilation cache + tiered-up
      # code warm across visits (measured −4.5..19% suite wall). Only a refused
      # reset falls back to the cold route: dispose the isolate and build a
      # fresh one (synchronously, on this thread).
      def rebuild_ctx
        # Produce any queued bytecode-cache blobs while every queued target
        # (frame realms included) is still alive — a job queued by the last
        # activity of a test (e.g. a timer-fired dynamic import in a lazy
        # frame) would otherwise compile against a disposed context and be
        # dropped, leaving the disk cache permanently cold for that body.
        ScriptCache.warm_pending!
        # Drop the previous page's iframe realms (a new visit = new nested
        # browsing contexts). Explicit — under warm-compile the isolate
        # survives, so nothing else would ever release them.
        dispose_frame_realms
        # Warm path: per rusty's reset contract the snapshot is REPLAYED —
        # including its precompiled code cache — so re-visited app modules
        # compile at in-memory-hit cost (~3.3× cheaper than a cold
        # `cached_data` deserialize; see `@compiled_module_urls`). Host fns,
        # module handles (invalidated via `Ctx#generation`), and every
        # post-snapshot `c.eval` died with the old realm — re-seed exactly
        # as `build_ctx` does after `Ctx.new`. A refused reset (mid-drain /
        # suspended request — can't happen from these top-level call sites,
        # but the contract reserves it, e.g. after a watchdog terminate
        # wedges a nested rendezvous) falls back to the cold rebuild below —
        # loudly, because a persistent fallback is an invisible perf cliff
        # (and log_console is trace-gated, nil during reset!).
        if @ctx
          begin
            @ctx.reset
            # `@ctx.reset` swaps in a snapshot-fresh realm and `dispose_frame_realms`
            # above tore down the visit's iframe realms — but V8 keeps those dead
            # contexts as RECLAIMABLE GARBAGE: a per-frame realm (within_frame /
            # `Isolate#create_context`) is a large GC root that V8's incremental
            # GC won't collect between visits. Over a long run (esp. iframe-heavy
            # pages) they pile toward the old-space cap, where the near-heap-limit
            # GC thrashes instead of reclaiming. A full GC under pressure drops the
            # used heap back to baseline (measured: ~450 MB -> ~150 MB, native
            # contexts N -> 1). See `relieve_heap_pressure`.
            relieve_heap_pressure
            attach_host_fns(@ctx)
            @ctx.eval('__csim_installWorker();')
            return @ctx
          rescue StandardError => e
            warn "[capybara-simulated] warm context reset failed, falling back to cold rebuild: #{e.class}: #{e.message}"
            @browser.log_console('warn', "warm context reset failed, falling back to full rebuild: #{e.message}")
          end
        end
        old = @ctx
        @ctx = nil
        # The cold rebuild brings up a *different* isolate, whose in-memory
        # compilation cache is cold — drop the no-cd tracking so the next
        # visit goes back through the on-disk bytecode-cache path.
        @compiled_module_urls.clear
        @compiled_script_keys.clear
        # Tear the old isolate down synchronously, on this (the only) thread
        # that ever drove it. Each isolate is created, used, and disposed on
        # the main thread — never dispatched to from a second thread (see
        # `ctx`), which rusty_racer's thread-confined isolates require. This
        # cold path is only the rare reset-failure fallback, so the inline
        # teardown isn't on the steady-state path.
        dispose_ctx(old) if old
        @ctx = build_and_track_ctx
      end

      # Capybara calls `Driver#reset!` between tests; Browser delegates
      # here. With per-visit rebuild already running, the inter-test
      # path is the same operation.
      def reset_page = rebuild_ctx

      # Memory-pressure threshold (MB) above which `rebuild_ctx` forces a full
      # GC to reclaim dead per-frame realms (see the call site). Measured
      # against used heap **+ external** (ArrayBuffer backing stores, image
      # pixel buffers) — `used_heap_size` alone misses the external component,
      # which on image-heavy specs is the bulk of the footprint. Default 1 GB:
      # far above a normal single visit (~200-500 MB) so ordinary specs never
      # trigger it, far below the 4 GB old-space cap so a multi-visit spec
      # reclaims long before the near-heap-limit GC would thrash. `0` disables.
      GC_PRESSURE_MB = (ENV['CSIM_V8_GC_PRESSURE_MB'] || '1024').to_i

      # Opt-in heap accounting on every rebuild (CSIM_HEAP_DIAG). Resolved once
      # at load (rule 3: don't re-read env per call); zero cost when off.
      HEAP_DIAG = !ENV['CSIM_HEAP_DIAG'].nil?

      # Forced full GC when V8-managed memory (used heap + external) crosses
      # GC_PRESSURE_MB. The stat read is cheap (a counter snapshot every visit);
      # the GC itself only fires once a multi-visit spec has actually piled up
      # dead realms — measured at ~once per 25-50 iframe-heavy visits, reclaiming
      # native contexts back to 1 and the heap to baseline — so the amortized
      # cost is negligible while memory stays bounded. No-op on rusty < 0.1.9
      # (no heap_statistics) or when disabled.
      def relieve_heap_pressure
        return unless GC_PRESSURE_MB.positive? && @ctx.heap_accounting?
        s    = @ctx.heap_statistics
        over = (s[:used_heap_size].to_i + s[:external_memory].to_i) > GC_PRESSURE_MB * 1_048_576
        if HEAP_DIAG
          warn(format('[csim heap] used=%dMB ext=%dMB native_ctx=%d over=%s',
                      s[:used_heap_size].to_i >> 20, s[:external_memory].to_i >> 20,
                      s[:number_of_native_contexts].to_i, over))
        end
        return unless over
        @ctx.low_memory_notification
        if HEAP_DIAG
          a = @ctx.heap_statistics
          warn(format('[csim heap]   -> after GC used=%dMB native_ctx=%d',
                      a[:used_heap_size].to_i >> 20, a[:number_of_native_contexts].to_i))
        end
      rescue StandardError
        # Older rusty without the diagnostics API, or a transient read failure —
        # heap relief is best-effort, never fail a visit over it.
      end

      # Built lazily on first use, on the calling (main) thread. There is no
      # pool / background pre-warm: under warm-compile the steady-state visit
      # reuses this one isolate via `Context#reset` (rebuild_ctx) and never
      # builds another, so a pool's async pre-warm bought nothing — and a pool
      # dispatched to its entries from a refill thread before the main thread
      # used them, migrating an isolate's caller thread. Building here keeps
      # every isolate confined to one thread for its whole life. The one-time
      # synchronous build is ~3 ms.
      def ctx
        return @ctx if @disposed   # don't resurrect a disposed runtime (closed window)
        @ctx ||= build_and_track_ctx
      end

      # build_ctx + register for at_exit cleanup.
      def build_and_track_ctx
        c = build_ctx
        @@live_lock.synchronize { @@live << c }
        c
      end

      # Terminate + dispose a tracked isolate and drop it from the at-exit
      # `@@live` registry. Dispose FIRST and de-register only on success: if
      # `dispose` raises (rescued), the isolate stays in `@@live` so the at_exit
      # sweep retries it instead of leaking it un-disposed. Shared by the
      # cold-rebuild fallback (`rebuild_ctx`) and `#dispose`.
      def dispose_ctx(c)
        return unless c
        c.terminate rescue nil
        c.dispose
        @@live_lock.synchronize { @@live.delete(c) }
      rescue StandardError
      end

      # Tear this runtime's isolate down for good. Each auxiliary window
      # (`window.open` / a switched-into `target=_blank`) is its own Browser +
      # V8Runtime + isolate; without this, closing the window reaped its
      # background threads (Browser#dispose) but left the isolate ALIVE — the
      # `@@live` at-exit registry holds a strong reference, so a bare GC never
      # reclaimed it. Over a long suite those isolates (and their RSS)
      # accumulated (measured: V8 isolate count 2 → 10, RSS ~2.7 → 6.6 GB across
      # the Discourse suite). Idempotent; only ever called on teardown
      # (Browser#dispose) — never on the per-test `reset_page` path, which
      # reuses the isolate via `Context#reset`. The `ctx` getter stops rebuilding
      # once `@disposed`, so a stray post-close call can't resurrect the isolate.
      def dispose
        return if @disposed
        @disposed = true
        dispose_frame_realms rescue nil
        c, @ctx = @ctx, nil
        dispose_ctx(c)
      end

      # Per-call wall-clock cap (ms). Off by default. Opt in via
      # `CSIM_V8_CALL_TIMEOUT_MS=30000` for long-running suites where an
      # occasional JS-side infinite loop would otherwise stall the whole
      # run; the timeout converts the hang into a
      # `RustyRacer::ScriptTerminatedError` on that one example — whose
      # `#message` / `#js_backtrace` (rusty >= 0.1.10) name the looping JS
      # frame (function + source position), so an in-V8 hang is diagnosable
      # from the failure alone, no live debugger attach needed. The
      # terminate escalates through any nested frames (it is
      # isolate-global by design), and the isolate itself stays healthy
      # for subsequent calls — csim treats a terminated call as fatal to
      # that call only. The clean slate comes from the next rebuild: a
      # warm `Context#reset` normally, or — if the terminate wedged a
      # suspended request and reset is refused — the loud cold-rebuild
      # fallback in `rebuild_ctx`.
      CALL_TIMEOUT_MS = (ENV['CSIM_V8_CALL_TIMEOUT_MS'] || '0').to_i

      # V8's bytecode-cache version tag. Keys every ScriptCache entry so a
      # V8 upgrade invalidates stale bytecode. Fixed per process → memoized.
      def self.cached_data_version_tag
        return @cached_data_version_tag if defined?(@cached_data_version_tag)
        @cached_data_version_tag = RustyRacer.cached_data_version_tag
      end

      def build_ctx
        c = Ctx.new(snapshot: @snapshot || self.class.snapshot, timeout: CALL_TIMEOUT_MS)
        attach_host_fns(c)
        c.eval('__csim_installWorker();')
        c
      end


      def attach_host_fns(c)
        self.class.attach_host_fns(c, @browser)
        attach_run_script_with_cache(c)
        attach_native_module_loader(c)
        attach_frame_realm_loader(c)
      end

      # The bridge calls `__csim_createFrameRealm(url, body, contentType, parentId)`
      # (from `iframe.contentWindow`'s getter) to spin up a real per-iframe realm
      # whose `parent`/`top` point at the realm `parentId` identifies. This
      # runs re-entrantly inside the main ctx's eval — rusty services nested
      # requests while a host callback is in flight. Returns the realm's context
      # id (or nil on failure — then the bridge keeps its same-realm fallback).
      # The bridge maps `iframe.contentWindow` to `RustyRacer.contextGlobal(id)`.
      def attach_frame_realm_loader(c)
        c.attach('__csim_createFrameRealm', ->(url, body, content_type, parent_id = 0, frame_name = nil, frame_doc_origin = nil, frame_location_origin = nil) {
          RuntimeShared.safe_call { create_frame_realm(c, url, body, content_type, parent_id, frame_name, frame_doc_origin, frame_location_origin) }
        })
        # Re-navigating an iframe (src/srcdoc reassigned) builds a fresh realm;
        # the bridge calls this to tear down the superseded one so it doesn't
        # linger in @frame_realms and get re-drained on every poll tick.
        # Disposing a non-executing child realm mid-callback is safe.
        c.attach('__csim_disposeFrameRealm', ->(id) {
          dispose_frame_realm(id)   # also revokes the realm's blob URLs
          nil
        })
      end

      # Build the iframe's realm: a snapshot-built isolate replays the whole
      # bridge into every new context automatically, so the realm already has
      # `document` / `DOMParser` / the event loop; re-seed the post-snapshot JS
      # state, point it at its own URL with the top frame as parent/top, then
      # load its document (running its scripts in the realm). Tracked for
      # event-loop draining + teardown.
      # Browsers cap nested browsing-context depth; with eager frame building a
      # self-referential or pathologically nested iframe (`<iframe src=self>`)
      # would otherwise build realms without bound and stall the settle loop.
      # Depth is one more than the parent realm's (the main frame is depth 0).
      MAX_FRAME_DEPTH = 16

      def frame_realm_depths = (@frame_realm_depths ||= {})

      def create_frame_realm(parent_ctx, url, body, content_type, parent_id = 0, frame_name = nil, frame_doc_origin = nil, frame_location_origin = nil)
        depth = (frame_realm_depths[parent_id] || 0) + 1
        if depth > MAX_FRAME_DEPTH
          @browser.log_console('warn', "iframe nesting depth #{depth} exceeds #{MAX_FRAME_DEPTH}; not building #{url}")
          return nil
        end
        realm = parent_ctx.create_context
        # Record depth BEFORE loading the document: the frame's own scripts run
        # during __csimLoadDocument below and may synchronously build NESTED frames
        # (their create_frame_realm looks up this realm's depth as their parent's),
        # so it must already be set or the nested depth undercounts and the cap
        # never trips.
        frame_realm_depths[realm.id] = depth
        # Re-evaling the snapshot source would redefine snapshot globals (e.g.
        # the `scrollX` accessor) and throw — re-entrantly. Only eval the
        # source on a bare no-snapshot dev ctx, where the realm boots empty.
        # Host fns are replayed onto the realm by `Ctx#create_context`.
        has_bridge = realm.eval("typeof __csimLoadDocument === 'function'")
        realm.eval(RuntimeShared.snapshot_src) unless has_bridge
        # The replayed `__csim_runScriptCached` / `__csim_runScriptEval` /
        # `__csim_evalEsmEntry` close over the context they EXECUTE in (the
        # main ctx) — left as-is, a frame script that routes through them
        # (leading-lexical, ≥64KB, or `type=module`) would run against the
        # PARENT realm's document. Rebind realm-executing variants on top.
        attach_run_script_with_cache(realm)
        attach_realm_esm_entry(realm)
        reseed_realm_js(realm)
        # Wire `parent` / `top` to the realm that owns this iframe (its context
        # id passed from `__csimFrameWindow`), BEFORE the frame's scripts run —
        # `top` propagates up the chain (the main realm's `top` is itself). A
        # nested frame thus reaches its TRUE parent, not unconditionally the
        # main frame. `parent_id` is an integer the marshaller carries verbatim.
        realm.eval(<<~JS)
          if (globalThis.#{HOST_NAMESPACE_NAME} && typeof globalThis.#{HOST_NAMESPACE_NAME}.contextGlobal === 'function') {
            var __parentWin = globalThis.#{HOST_NAMESPACE_NAME}.contextGlobal(#{parent_id.to_i});
            if (__parentWin) {
              // Expose `parent`/`top` as THIS realm's WindowProxy for them (not the
              // raw parent global) so `e.source === parent` holds and a frame's
              // `parent.postMessage(...)` attributes the sender. `top` resolves
              // through the parent's own top (already a proxy if the parent is a
              // frame), unwrapped to its raw global then re-proxied for this realm.
              var __NS = globalThis.#{HOST_NAMESPACE_NAME};
              var __pf = globalThis.__csimFrameWindowProxyFor;
              if (__pf && __NS && typeof __NS.contextOf === 'function') {
                var __topRaw = __parentWin.top || __parentWin;
                if (__topRaw && __topRaw.__csimRawWindow) __topRaw = __topRaw.__csimRawWindow;
                globalThis.parent = __pf(__NS.contextOf(__parentWin)) || __parentWin;
                globalThis.top    = __pf(__NS.contextOf(__topRaw)) || __topRaw;
              } else {
                globalThis.parent = __parentWin;
                globalThis.top    = __parentWin.top || __parentWin;
              }
            }
          }
        JS
        # Pass the URL + document body as call ARGUMENTS, not interpolated into
        # an eval string: the marshaller carries them losslessly, so arbitrary
        # HTML / control bytes survive (Ruby's String#inspect is NOT a faithful
        # JS string escaper — it mangles \a, \e, and binary bytes).
        realm.call('__csimUpdateLocation', url.to_s) unless url.to_s.empty?
        # Set window.name from the container's `name` attribute BEFORE the document
        # loads, so a frame whose load handler reads window.name to identify itself
        # (declarative-shadow declarative-child-frame) sees it.
        realm.call('__csimSetWindowName', frame_name.to_s) unless frame_name.nil?
        # Seed the frame's document origin (opaque/inherited) BEFORE the document
        # loads, so its load-time scripts read the right self.origin. nil → a
        # real-URL frame whose origin is its own location origin.
        realm.call('__csimSetDocumentOrigin', frame_doc_origin.to_s) unless frame_doc_origin.nil?
        # The frame's location.origin (opaque "null" for about:blank / srcdoc /
        # javascript:); decoupled from the location string so navigation is intact.
        realm.call('__csimSetLocationOrigin', frame_location_origin.to_s) unless frame_location_origin.nil?
        realm.call('__csimLoadDocument', body.to_s, content_type.to_s)
        frame_realms[realm.id] = realm
        # Fire the nested document's window `load`. The frame's inline scripts ran
        # during __csimLoadDocument and registered their `window.onload` (the usual
        # `window.onload = () => parent.postMessage(...)` a frame reports back
        # through); without firing it, an eagerly-built frame that the parent never
        # touches would never run its load handler. Safe if no handler is set
        # (dispatches to an empty listener list). Guarded so a frame whose load
        # handler throws doesn't abort the build.
        realm.call('__csimFireWindowLoad') rescue nil
        realm.id
      rescue StandardError => e
        @browser.log_console('warn', "frame realm load failed: #{e.message}")
        # A realm created before the failure (load threw) is untracked — not in
        # frame_realms nor __csimChildRealmIds — so nothing would ever drain or
        # dispose it. Tear it down here (safe: it's non-executing in the rescue),
        # including any module handles its scripts compiled before the throw.
        if realm
          @realm_module_handles&.delete(realm.id)
          realm.dispose rescue nil
        end
        nil
      end

      # `target` is the context the module graph compiles + evaluates in,
      # `handles` its module-handle cache — the main ctx + `native_module_handles`
      # by default, or a frame realm + its realm-local cache (Module handles are
      # context-bound; sharing the main cache would link a frame's imports
      # against main-context modules).
      def eval_esm_module(url, inline_src = nil, target: nil, handles: nil)
        target  ||= ctx
        handles ||= native_module_handles
        m = native_module_for(url, inline_src, target, handles)
        return nil unless m
        begin
          instantiate_native_module(m, url, target, handles)
          m.evaluate
        rescue RustyRacer::ParseError, RustyRacer::RuntimeError => e
          # A top-level module throw belongs on the page console
          # (trace-visible diagnostics), like a classic script's error —
          # not just safe_call's truncated stderr warn. ScriptTerminatedError
          # deliberately propagates (a watchdog terminate must escalate).
          @browser.log_console('error', "module evaluate error in #{url}: #{e.message}")
        end
        nil
      end

      # A `.json` module is exposed as the default export of its parsed value;
      # every other body is the fetched source as-is. Module SOURCE is text,
      # but it arrives as the raw Rack / File.binread body — tagged
      # ASCII-8BIT (see `RuntimeShared.utf8_text`).
      def module_body(url, src)
        src = RuntimeShared.utf8_text(src)
        url.to_s.match?(/\.json(?:\?|$)/) ? "export default #{src};" : src
      end

      # `RustyRacer::Module` handles are bound to their realm; both rebuild
      # paths invalidate them. The key carries `Ctx#generation` because a
      # warm reset keeps the same Ctx OBJECT — object_id alone can't see it.
      def native_module_handles
        @native_module_handles ||= {}
        key = [ctx.object_id, ctx.generation]
        if @native_module_handles_key != key
          @native_module_handles     = {}
          @native_module_handles_key = key
        end
        @native_module_handles
      end

      def native_module_for(url, inline_src, target, handles)
        return handles[url] if handles.key?(url)
        url_s = url.to_s
        src = inline_src || @browser.rack_fetch_body(url_s)
        return handles[url] = nil unless src
        body = module_body(url_s, src)
        # No-cd warm path: once this isolate has compiled a URL, its in-memory
        # compilation cache holds the bytecode keyed by source — skip
        # `cached_data` so V8 hits that cache directly (~0.04 ms/module)
        # instead of paying the forced kConsumeCodeCache deserialize
        # (~0.15 ms/module). The first compile of each URL goes through the
        # on-disk bytecode cache and warms it. The in-memory cache is
        # source-keyed and re-populated by every compile, so a changed body
        # or a GC-aged-out entry costs ONE re-parse and is warm again — no
        # sticky cliff. (Only the on-disk blob for a changed body stays
        # unwarmed; acceptable, module URLs here are fingerprinted-
        # immutable.) Realms share the isolate's cache, so the tracking
        # applies to frame-realm compiles too. On a cold rebuild
        # `@compiled_module_urls` is cleared and everything returns to the
        # `cached_data` path.
        if inline_src.nil? && @compiled_module_urls.key?(url_s)
          m = target.compile_module(body, filename: url_s)
        else
          sha     = Digest::SHA256.hexdigest(body)
          version = self.class.cached_data_version_tag
          cached  = ScriptCache.lookup(sha, version, kind: :module)
          m       = target.compile_module(body, filename: url_s, cached_data: cached)
          if cached.nil? || m.cache_rejected?
            ScriptCache.queue_warm(target, sha, url_s, body, version, kind: :module, stale: !cached.nil?)
          end
          @compiled_module_urls[url_s] = true if inline_src.nil?
        end
        handles[url] = m
      rescue RustyRacer::ParseError => e
        @browser.log_console('error', "module parse error in #{url}: #{e.message}")
        handles[url] = nil
      end

      def instantiate_native_module(m, importer_url, target, handles)
        return unless m.status == :uninstantiated
        browser = @browser
        m.instantiate do |specifier, referrer|
          resolved = browser.resolve_module_specifier(specifier, referrer || importer_url)
          child = native_module_for(resolved, nil, target, handles)
          raise "module not found: #{resolved}" unless child
          child
        end
      end

      # `import('x')` routes through this callback; rusty's native side
      # finishes the dynamic import per the V8 host contract — it
      # instantiates + evaluates the returned Module (TLA-aware, via the
      # evaluation promise) before resolving the outer `import()` promise.
      # The resolver is per-ISOLATE; rusty hands it the INITIATING realm's
      # Context as the third argument, so a frame realm's `import()`
      # compiles + links in that realm with its own handle cache — same
      # realm-correctness as static `<script type=module>` via
      # `attach_realm_esm_entry`.
      def attach_native_module_loader(c)
        c.attach('__csim_evalEsmEntry', ->(url, inline) {
          RuntimeShared.safe_call { eval_esm_module(url, inline) }
          nil
        })
        c.dynamic_import_resolver = ->(specifier, referrer, initiating) {
          target, handles =
            if initiating && initiating.id != 0
              [initiating, realm_module_handles(initiating.id)]
            else
              [ctx, native_module_handles]
            end
          resolved = @browser.resolve_module_specifier(specifier, referrer)
          m = native_module_for(resolved, nil, target, handles)
          raise "module not found: #{resolved}" unless m
          instantiate_native_module(m, resolved, target, handles)
          m
        }
      end

      # Per-realm module-handle caches, keyed by realm id (Module handles are
      # context-bound). Shared by the realm's static `__csim_evalEsmEntry`
      # and the isolate resolver's dynamic-import routing; dropped with the
      # realm in the dispose paths.
      def realm_module_handles(realm_id)
        (@realm_module_handles ||= {})[realm_id] ||= {}
      end

      # Frame-document `<script type=module>` entry, bound to the realm.
      def attach_realm_esm_entry(realm)
        realm.attach('__csim_evalEsmEntry', ->(url, inline) {
          RuntimeShared.safe_call {
            eval_esm_module(url, inline, target: realm, handles: realm_module_handles(realm.id))
          }
          nil
        })
      end

      # Override the JS-side `__csim_runScript` fallback with a Ruby host fn
      # that bytecode-caches each script body in a process-wide hash + on-disk
      # store (`Context#compile` + `Script#cached_data`). Discourse's main
      # chunk is ~140 ms of parse + JIT per visit otherwise; the cache reduces
      # it to a deserialize + run path. Worker isolates run on their own
      # threads — `compile` from the main thread against a Worker isolate is
      # unsafe — so the class-level `attach_host_fns` (used by `build_worker`)
      # intentionally skips this attach.
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
        version_tag = self.class.cached_data_version_tag
        debug = ENV['CSIM_SCRIPT_CACHE_DEBUG']
        # Big bodies → Ruby-side bytecode cache. The dispatcher below
        # routes small bodies to a JS-only `(0, eval)` so they don't
        # pay the rendezvous round-trip.
        c.attach('__csim_runScriptCached', ->(label, body) {
          RuntimeShared.safe_call {
            # Trailing `;undefined` suppresses the script's COMPLETION VALUE so
            # `script.run`'s return crosses the V8→Ruby boundary on the trivial
            # marshalling fast path. Without it, a large inline script ending
            # in a jQuery-ish expression returns a `ce.fn.init` (array-like,
            # non-cloneable) that drags through the deep-copy filter —
            # pure waste, since the value is discarded (`nil` below). The SHA keys
            # the bytecode cache on the COMPILED source, so the suffix must be
            # hashed and fed to `queue_warm` too (else cached_data is rejected).
            src = "#{body}\n;undefined"
            # No-cd warm path, mirroring `native_module_for`: once this
            # isolate has compiled a (label, bytesize), re-visits compile
            # straight against V8's source-keyed in-memory cache — skipping
            # the SHA256 of a 140KB+ chunk per visit (rbspy: ~4.8% of the
            # Discourse perf sample was Digest#update) AND the disk lookup.
            # The key is a heuristic, but a false positive only costs a
            # plain recompile of the true source — never wrong code.
            key = [label.to_s, src.bytesize]
            if @compiled_script_keys.key?(key)
              script = c.compile(src, filename: label.to_s)
            else
              sha    = Digest::SHA256.hexdigest(src)
              cached = ScriptCache.lookup(sha, version_tag)
              script = c.compile(src, filename: label.to_s, cached_data: cached)
              $stderr.puts "[runScript] label=#{label.to_s[0,60]} hit=#{!cached.nil?} rejected=#{script.cache_rejected?}" if debug
              # V8 forbids `produce_cache: true` from inside a host-fn
              # callback so we queue misses + rejects for top-level
              # produce via `ScriptCache.warm_pending!` after the
              # current `V8Runtime#call` returns.
              if cached.nil? || script.cache_rejected?
                ScriptCache.queue_warm(c, sha, label, src, version_tag, stale: !cached.nil?)
              end
              @compiled_script_keys[key] = true if key
            end
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
        # raises RustyRacer::RuntimeError, which rusty re-raises as a
        # JS exception at the call site — so bridge.entry.js's
        # `try { __csim_runScript(…) } catch (e)` sees it and runs its
        # normal path (console diagnostic, `_ok=false`, fire the script
        # `error` event), exactly as the JS-side `(0, eval)` does and
        # as the QuickJS runner does. Swallowing here would turn a
        # throwing leading-`const` inline script into a silent `load`.
        c.attach('__csim_runScriptEval', ->(label, body) {
          # Trailing `;undefined` makes the script's COMPLETION VALUE undefined so
          # `c.eval`'s return crosses the V8→Ruby boundary on the trivial
          # marshalling fast path. Without it, a leading-lexical inline script
          # ending in a jQuery-ish expression (`const cfg=…; $(…)`) returns a
          # `ce.fn.init` (array-like, non-cloneable) here, which falls into the
          # deep-copy filter slow-path — pure waste, since the value
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
      # JS-only `(0, eval)` fast path. It snapshots the CURRENT
      # `__csim_runScriptCached` / `__csim_runScriptEval` host fns, so it must
      # run after the attaches it captures (`attach_run_script_with_cache`
      # installs it last for exactly that reason).
      def install_run_script_dispatcher(c)
        c.eval(<<~JS)
          (function () {
            const cached    = globalThis.__csim_runScriptCached;
            const runEval   = globalThis.__csim_runScriptEval;
            const threshold = #{SCRIPT_CACHE_MIN_BYTES};
            // Leading top-level lexical declaration, after optional BOM /
            // whitespace / line+block comments / a "use strict" prologue.
            const LEADS_LEXICAL = /^[\\s\\uFEFF]*(?:(?:\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)\\s*)*(?:["']use strict["'];?\\s*)?(?:export\\s+)?(?:const|let|class)[\\s{\\[]/;
            // A "use strict" directive prologue. A classic <script> evaluates as a
            // top-level Script, where top-level `var` / `function` declarations
            // bind on the global object even in strict mode — but the JS-only
            // `(0, eval)(body)` fast path runs them as an INDIRECT eval, and a
            // strict indirect eval gets its OWN variable environment, so those
            // declarations never reach globalThis (a later <script> can't see
            // them). Route strict-prologue scripts through the real top-level
            // `ctx.eval` path too, same as leading lexical declarations.
            const LEADS_USE_STRICT = /^[\\s\\uFEFF]*(?:(?:\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)\\s*)*["']use strict["']/;
            globalThis.__csim_runScript = function (label, body) {
              if (body.length >= threshold) return cached(label, body);
              if (LEADS_LEXICAL.test(body) || LEADS_USE_STRICT.test(body)) return runEval(label || 'csim-eval', body);
              (0, eval)(body + '\\n//# sourceURL=' + (label || 'csim-eval'));
            };
          })();
        JS
      end

      # A fresh per-frame realm boots from the snapshot, so every
      # `globalThis.…` assignment csim ran *post-snapshot* in `build_ctx` is
      # missing (realm state). Re-seed the `__csim_yield` alias and the
      # `__csim_installWorker()` post-snapshot init; the `__csim_runScript`
      # dispatcher comes from `attach_run_script_with_cache` (realm-bound).
      def reseed_realm_js(c)
        c.eval("globalThis.__csim_yield = globalThis.#{HOST_NAMESPACE_NAME}.drainMicrotasks;")
        c.eval('__csim_installWorker();')
      end

      # Class-level attach so Worker isolates (Ruby-thread-owned
      # contexts that don't have a Runtime instance wrapping them)
      # reuse the same `BROWSER_HOST_FNS` + `STDLIB_HOST_FNS` table
      # the main runtime wires up.
      def self.attach_host_fns(c, browser)
        fns = {}
        RuntimeShared::BROWSER_HOST_FNS.each {|name, body|
          fns[name] = ->(*a) { RuntimeShared.safe_call { body.call(browser, *a) } }
        }
        fns.update(RuntimeShared::STDLIB_HOST_FNS)
        # One rendezvous for the whole table (~50 fns) — this runs per cold
        # build, per worker, and per warm realm reset.
        c.attach_many(fns)
        # `dispatchEventForUserAction` calls `__csim_yield` between listener
        # invocations to match HTML spec "clean up after running script"
        # microtask-checkpoint semantics. Alias it to the namespace's native
        # in-isolate checkpoint so callers pay ~sub-µs instead of an
        # attached-fn cross-thread round-trip.
        c.eval("globalThis.__csim_yield = globalThis.#{HOST_NAMESPACE_NAME}.drainMicrotasks;")
        # Register the bridge's recorder for V8's promise-reject notifications
        # — the channel that surfaces rejections NO handler ever sees
        # (fire-and-forget async functions, bare `Promise.reject`); the
        # bridge's `.then`-wrap can't observe those. Post-snapshot: the host
        # namespace doesn't exist while the snapshot is built, which is why
        # unhandled-rejection.js leaves registration to us. Main realm only —
        # the recorder routes per-realm via `contextGlobal` itself, and a
        # frame-realm registration would dangle once that realm is disposed.
        c.eval(<<~JS)
          if (typeof globalThis.#{HOST_NAMESPACE_NAME}.setPromiseRejectHandler === 'function' &&
              typeof globalThis.__csimPromiseRejected === 'function') {
            globalThis.#{HOST_NAMESPACE_NAME}.setPromiseRejectHandler(globalThis.__csimPromiseRejected);
          }
        JS
      end

      # Worker-isolate factory: fresh isolate from the shared
      # snapshot, host fns attached, `__csim_isWorker` flag set, +
      # the per-worker postMessage host fn closed over `post_back`.
      # Returns a uniform `WorkerRuntime` adapter that
      # `Browser#run_worker` drives.
      def self.build_worker(browser, post_back)
        c = Ctx.new(snapshot: snapshot)
        attach_host_fns(c, browser)
        c.attach('__csim_workerPostMessage', ->(data) { post_back.call(data); nil })
        # Worker's timer table is independent from main's; routing the
        # worker's `setTimersActive` through `browser.timers_active=`
        # races the main isolate's polling? gate, dropping main-thread
        # pending XHRs the moment the worker's queue empties. The settle
        # loop already polls `worker_pending?` for worker thread activity.
        c.attach('__setTimersActive', ->(_flag) { nil })
        c.eval('__csim_installWorkerScope();')
        WorkerRuntime.new(
          eval_fn:           ->(s)     { c.eval(s.to_s) },
          call_fn:           ->(n, *a) { c.call(n.to_s, *a) },
          drain_microtasks:  ->        { c.perform_microtask_checkpoint },
          drain_timers:      ->        { c.call('__drainTimers', 50) },
          has_ready_timer:   ->        { !!c.call('__hasReadyTimer') },
          dispose:           ->        { c.dispose rescue nil }
        )
      end
    end
  end
end
