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
  max_old_mb = (ENV['CSIM_V8_MAX_OLD_SPACE_MB'] || '4096').to_i
  RustyRacer::Platform.set_flags!('max-old-space-size': max_old_mb) if max_old_mb > 0
  # `CSIM_V8_PROF=1` turns on V8's tick-sampling profiler. Output
  # lands in `isolate-*-v8.log`; process with:
  #   node --prof-process isolate-*-v8.log > prof.txt
  # (Standard Node distribution ships the post-processor; no extra
  # install needed.) The log is per-isolate, so per-visit
  # `rebuild_ctx` produces one file per isolate.
  if ENV['CSIM_V8_PROF'] == '1'
    RustyRacer::Platform.set_flags!(:prof, 'logfile-per-isolate': nil)
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
          @iso      = RustyRacer::Isolate.new(host_namespace: HOST_NAMESPACE_NAME,
                                              snapshot:       snapshot,
                                              timeout_ms:     timeout.to_i)
          @ctx      = @iso.context
          @attached = []
        end

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

        def compile(src, **kw)        = @ctx.compile(src, **kw)
        def compile_module(src, **kw) = @ctx.compile_module(src, **kw)

        # ── Isolate surface ─────────────────────────────────────────
        def terminate                        = @iso.terminate
        def dispose                          = @iso.dispose
        def perform_microtask_checkpoint     = @iso.perform_microtask_checkpoint

        def dynamic_import_resolver=(prc)
          @iso.dynamic_import_resolver = prc
        end

        # A per-iframe realm: a fresh context in the SAME isolate (shared heap,
        # own global + intrinsics). Carries `.id` / eval / call / dispose — the
        # rest of the surface `create_frame_realm` needs.
        #
        # The replay is one attach (= one rendezvous) per host fn, ~55 per
        # realm; a batched attach on the rusty side would collapse it to one.
        # Fine at current iframe densities — revisit if a suite ever leans on
        # iframe-heavy pages. NOTE: context-bound fns (`__csim_runScript*`,
        # `__csim_evalEsmEntry`) get realm-bound overrides in
        # `create_frame_realm` after this replay.
        def create_context
          realm = @iso.create_context
          @attached.each {|name, prc| realm.attach(name, prc) }
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

      # Maintain a small pool of warmed-up contexts per Browser. Each
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

      # Per-iframe realms (`Isolate#create_context`): a separate V8 context —
      # own global + intrinsics (Function/Error/DOMParser/onerror) — per
      # nested browsing context, so cross-realm tests behave per spec. Keyed by
      # context id; dropped on every ctx rebuild (the realms die with the isolate).
      def frame_realms = (@frame_realms ||= {})

      def dispose_frame_realms
        return if @frame_realms.nil?
        @frame_realms.each_value {|fr| fr.dispose rescue nil }
        @frame_realms.clear
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

      # Tears down the current context and brings up a fresh one from
      # the warm snapshot. Partial in-context resets are not safe (see
      # feedback_visit_always_rebuilds memory): library init guards
      # stick, delegate registrations leak between visits. The snapshot
      # warmup keeps the per-rebuild cost ~3 ms; jQuery / app-bundle
      # re-eval dominates after that.
      def rebuild_ctx
        # Drop the previous page's iframe realms (a new visit = new nested
        # browsing contexts). Safe here — we're between visits, not mid-callback.
        dispose_frame_realms
        old = @ctx
        @ctx = nil
        # Hand the old context off to a disposal thread so the next
        # visit doesn't wait on V8 teardown. Dispose order doesn't
        # matter — handles + listeners die with the isolate.
        if old
          @@live_lock.synchronize { @@live.delete(old) }
          Thread.new { begin
            old.terminate rescue nil
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

      # Pulls a warm context from the pool; if the pool is empty
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

      # Per-call wall-clock cap (ms). Off by default. Opt in via
      # `CSIM_V8_CALL_TIMEOUT_MS=30000` for long-running suites where an
      # occasional JS-side infinite loop would otherwise stall the whole
      # run; the timeout converts the hang into a
      # `RustyRacer::ScriptTerminatedError` on that one example. The
      # terminate escalates through any nested frames (it is
      # isolate-global by design), and the isolate itself stays healthy
      # for subsequent calls — csim treats a terminated call as fatal to
      # that call only (the per-visit rebuild supplies the clean slate).
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

      def refill_pool_async
        target = POOL_SIZE
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
      # runs re-entrantly inside the main ctx's eval — rusty services nested
      # requests while a host callback is in flight. Returns the realm's context
      # id (or nil on failure — then the bridge keeps its same-realm fallback).
      # The bridge maps `iframe.contentWindow` to `RustyRacer.contextGlobal(id)`.
      def attach_frame_realm_loader(c)
        c.attach('__csim_createFrameRealm', ->(url, body, content_type) {
          RuntimeShared.safe_call { create_frame_realm(c, url, body, content_type) }
        })
        # Re-navigating an iframe (src/srcdoc reassigned) builds a fresh realm;
        # the bridge calls this to tear down the superseded one so it doesn't
        # linger in @frame_realms and get re-drained on every poll tick.
        # Disposing a non-executing child realm mid-callback is safe.
        c.attach('__csim_disposeFrameRealm', ->(id) {
          fr = frame_realms.delete(id)
          fr.dispose rescue nil if fr
          nil
        })
      end

      # Build the iframe's realm: a snapshot-built isolate replays the whole
      # bridge into every new context automatically, so the realm already has
      # `document` / `DOMParser` / the event loop; re-seed the post-snapshot JS
      # state, point it at its own URL with the top frame as parent/top, then
      # load its document (running its scripts in the realm). Tracked for
      # event-loop draining + teardown.
      def create_frame_realm(parent_ctx, url, body, content_type)
        realm = parent_ctx.create_context
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
        # Wire parent/top to the main realm (context id 0). No user data in
        # this eval — only the literal namespace.
        realm.eval(<<~JS)
          if (globalThis.#{HOST_NAMESPACE_NAME} && typeof globalThis.#{HOST_NAMESPACE_NAME}.contextGlobal === 'function') {
            var __topWin = globalThis.#{HOST_NAMESPACE_NAME}.contextGlobal(0);
            globalThis.parent = __topWin; globalThis.top = __topWin;
          }
        JS
        # Pass the URL + document body as call ARGUMENTS, not interpolated into
        # an eval string: the marshaller carries them losslessly, so arbitrary
        # HTML / control bytes survive (Ruby's String#inspect is NOT a faithful
        # JS string escaper — it mangles \a, \e, and binary bytes).
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

      # `RustyRacer::Module` handles are bound to their context; rebuild_ctx
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

      def native_module_for(url, inline_src, target, handles)
        return handles[url] if handles.key?(url)
        url_s = url.to_s
        src = inline_src || @browser.rack_fetch_body(url_s)
        return handles[url] = nil unless src
        body    = module_body(url_s, src)
        sha     = Digest::SHA256.hexdigest(body)
        version = self.class.cached_data_version_tag
        cached  = ScriptCache.lookup(sha, version, kind: :module)
        m       = target.compile_module(body, filename: url_s, cached_data: cached)
        ScriptCache.queue_warm(target, sha, url_s, body, version, kind: :module) if cached.nil? || m.cache_rejected?
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
      # The resolver is per-ISOLATE and compiles against the MAIN ctx — a
      # dynamic `import()` issued from a frame realm would link main-context
      # modules (rusty doesn't surface the initiating context); static
      # `<script type=module>` in frames is realm-correct via
      # `attach_realm_esm_entry`.
      def attach_native_module_loader(c)
        c.attach('__csim_evalEsmEntry', ->(url, inline) {
          RuntimeShared.safe_call { eval_esm_module(url, inline) }
          nil
        })
        c.dynamic_import_resolver = ->(specifier, referrer) {
          resolved = @browser.resolve_module_specifier(specifier, referrer)
          m = native_module_for(resolved, nil, ctx, native_module_handles)
          raise "module not found: #{resolved}" unless m
          instantiate_native_module(m, resolved, ctx, native_module_handles)
          m
        }
      end

      # Frame-document `<script type=module>` entry, bound to the realm with
      # a realm-local handle cache (it dies with the realm's closure).
      def attach_realm_esm_entry(realm)
        handles = {}
        realm.attach('__csim_evalEsmEntry', ->(url, inline) {
          RuntimeShared.safe_call { eval_esm_module(url, inline, target: realm, handles: handles) }
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
            globalThis.__csim_runScript = function (label, body) {
              if (body.length >= threshold) return cached(label, body);
              if (LEADS_LEXICAL.test(body)) return runEval(label || 'csim-eval', body);
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
        RuntimeShared::BROWSER_HOST_FNS.each {|name, body|
          c.attach(name, ->(*a) { RuntimeShared.safe_call { body.call(browser, *a) } })
        }
        RuntimeShared::STDLIB_HOST_FNS.each {|name, body|
          c.attach(name, body)
        }
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
