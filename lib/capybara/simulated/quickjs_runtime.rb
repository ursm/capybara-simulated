# frozen_string_literal: true

# QuickJS-backed Runtime, alternate to `V8Runtime`. The DOM still lives
# in JS (same bridge.js, same vendor bundle); this class swaps the engine to
# trade JIT speed for ~10× smaller per-VM footprint — useful when the
# scaling target is "many parallel workers on a fixed RAM budget"
# rather than absolute per-spec wall time.
#
# Surface mirrors `V8Runtime` exactly: `eval` / `call` / `drain_timers`
# / `drain_microtasks` / `settle_gen` / `has_ready_timer?` /
# `reset_timers` / `rebuild_ctx` / `reset_page`. Browser code is
# engine-agnostic.

require 'digest'
require 'quickjs'

require_relative 'runtime_shared'
require_relative 'worker_runtime'

module Capybara
  module Simulated
    class QuickJSRuntime
      # Compile the vendor bundle + bridge.js into bytecode once per process.
      # Every per-visit VM replays this in ~10–20 ms (PR 31's microbench: 504KB
      # bundle in ~4 ms; vendor + bridge is ~10× larger). Side effects (class
      # definitions, the xpathway `Document.prototype.evaluate` install) run on
      # each new VM — `compile` itself is pure (`COMPILE_ONLY` flag).
      @@bridge_lock     = Mutex.new
      @@bridge_runnable = nil

      def self.bridge_runnable
        @@bridge_lock.synchronize { @@bridge_runnable ||= Quickjs::VM.new.compile(RuntimeShared.snapshot_src, filename: 'csim_bridge.js') }
      end

      # Process-wide cache of compiled `<script>` bodies (classic + ESM
      # factory wrappers). Bridge.js routes each body through
      # `__csim_runScript`; first encounter compiles into bytecode, every
      # subsequent visit replays the cached `Runnable` against the
      # current VM. The compile (PR 31 microbench: 504 KB → ~4 ms; Avo's
      # bundle is ~10×) is the cost we're skipping.
      #
      # No size cap: typical app surface is a few hundred unique bodies
      # (jQuery, Stimulus, Turbo, app bundle, per-page inlines). If a
      # test suite generates pathological cardinality we can add LRU
      # later — for now the parser-overhead saving dwarfs the cache RSS.
      @@runnable_cache_lock = Mutex.new
      @@runnable_cache      = {}

      # Sharing one compiler VM serialises compile calls, but compilation
      # is CPU-bound C and parallel workers each have their own
      # `QuickJSRuntime` class state (Ruby's `@@` is per-class, shared
      # in-process). One compile-only VM is enough; creating a fresh
      # `Quickjs::VM.new` per compile (~140 ms each for POLYFILL_INTL)
      # would dwarf the compile itself.
      @@compiler_lock = Mutex.new
      @@compiler_vm   = nil

      def self.runnable_for(body, label)
        key    = Digest::SHA256.hexdigest(body)
        cached = @@runnable_cache_lock.synchronize { @@runnable_cache[key] }
        return cached if cached
        fresh = @@compiler_lock.synchronize {
          @@compiler_vm ||= Quickjs::VM.new
          @@compiler_vm.compile(body, filename: label.to_s)
        }
        @@runnable_cache_lock.synchronize { @@runnable_cache[key] ||= fresh }
      end

      # Pre-warmed pool of bare `Quickjs::VM` instances. `Quickjs::VM.new`
      # with `POLYFILL_INTL` is ~140 ms (FormatJS locale tables + IANA TZ
      # bytecode); quickjs.rb #36 released the GVL during construction,
      # so warmer threads build in parallel with the main thread.
      # `build_vm` pops a pre-built VM and only pays for bridge replay +
      # host-fn attach (~30 ms) on the hot path.
      class VmPool
        # 4 warmers × ~140 ms ≈ 28 VMs/sec — covers sustained demand for
        # shared-spec-shaped runs. CAPACITY buffers short bursts before
        # warmers backfill.
        WARMER_COUNT = 4
        CAPACITY     = 6

        def initialize(vm_options)
          @vm_options = vm_options
          @queue      = SizedQueue.new(CAPACITY)
          @threads    = WARMER_COUNT.times.map {|i|
            Thread.new { warmer_loop }.tap {|t| t.name = "csim-qjs-warmer-#{i}" }
          }
        end

        def checkout = @queue.pop

        # SizedQueue#close unblocks pushers + makes future pops return
        # nil — necessary at process exit because a warmer mid-`VM.new`
        # has the GVL released and would SEGV on interpreter teardown.
        def shutdown
          @queue.close
          @threads.each {|t| t.join(2) }
        end

        private

        def warmer_loop
          loop { @queue.push(Quickjs::VM.new(**@vm_options)) }
        rescue ClosedQueueError
          # process exit
        end
      end

      @@pool_lock = Mutex.new
      @@pool      = nil

      def self.pool
        @@pool_lock.synchronize { @@pool ||= VmPool.new(VM_OPTIONS) }
      end

      at_exit do
        @@pool_lock.synchronize { @@pool&.shutdown }
      rescue StandardError
        # Best-effort at process exit.
      end

      def initialize(browser)
        @browser  = browser
        @vm       = nil
        @runnable = self.class.bridge_runnable
        self.class.pool # eager-start the warmers on first Browser
      end

      def eval(code)
        v = vm
        result = v.eval_code(code.to_s)
        v.drain_jobs!
        normalize(result)
      end

      # the V8 engine drains its microtask queue at
      # the end of every call (V8's default microtask policy). QuickJS
      # does not: `js_std_await` only pumps pending jobs while it's
      # waiting for an actual Promise to resolve, and host-fn returns
      # are plain values. Without a manual pump after every call,
      # Promise.then chains queued during a host-fn body (Turbo's
      # await fetch / Stimulus controllers, `evaluate_async_script`
      # test scripts) stall until the next async boundary.
      # `drain_jobs!` (quickjs.rb 0.18+) wraps `JS_ExecutePendingJob`
      # in a loop to empty the queue, bounded by the VM's `timeout_msec`.
      def call(name, *args)
        v = vm
        result = v.call(name.to_s, *args)
        v.drain_jobs!
        normalize(result)
      end

      # QuickJS has no per-frame realms (iframes share the one VM): `within_frame` falls back to
      # the same realm, and any realm id routes to the single global context.
      def supports_frames? = false

      def realm_call(_realm_id, name, *args) = call(name, *args)

      # No per-frame realms, so no realm is ever "alive" as a distinct browsing context —
      # every client id resolves to 'client-window' (the single global). Defined so a
      # caller that gates realm routing on it (deliver_worker_messages) works on both engines.
      def frame_realm_alive?(_realm_id) = false

      def frame_realm_ids = []

      # bridge.js owns the virtual clock; we drive it from Ruby because
      # Capybara's polling cadence is wall-clock-anchored.
      def drain_timers(max_ms = nil)
        max_ms.nil? ? vm.call('__drainTimers') : vm.call('__drainTimers', max_ms.to_i)
      end

      # One event-loop step; returns `{ 'fired', 'gen', 'dirtied' }` (see
      # V8Runtime#run_loop_step). `dirtied` = settleGen changed during the step.
      def run_loop_step(max_ms, max_iter = 10_000, yield_on_gen: false)
        r = vm.call('__runLoopStep', max_ms.to_i, max_iter.to_i, !!yield_on_gen)
        r.is_a?(Hash) ? r : { 'fired' => 0, 'gen' => 0, 'dirtied' => false }
      end

      # `drain_jobs!` loops to queue-empty — one call is a full checkpoint,
      # same contract as `V8Runtime#drain_microtasks`.
      def drain_microtasks
        vm.drain_jobs!
      end

      # No binary marshaler: QuickJS reinterprets high-bit bytes as UTF-8 and
      # corrupts them, so binary payloads cross as base64 and the JS shim's
      # `fetchedToBytes` atob's them back (see Browser#transfer_buffer_fetch_for_js).
      def wrap_binary(bytes)
        Base64.strict_encode64(bytes)
      end

      def settle_gen
        vm.call('__settleGenGet').to_i
      end

      def has_ready_timer?
        return false if @vm.nil?
        !!vm.call('__hasReadyTimer')
      end

      # Delay (ms) until the nearest scheduled timer relative to the virtual
      # clock, or -1 if none. Drives the horizon-gated fast-forward in
      # `Browser#tick_real_time`.
      def next_timer_delay_ms
        return -1 if @vm.nil?
        vm.call('__nextTimerDelay').to_i
      end

      def reset_timers
        return if @vm.nil?
        vm.call('__resetTimers')
      end

      # Tear down the current VM and build a fresh one from the
      # precompiled bytecode. Partial in-VM resets carry the same
      # library-init-leak hazards V8Runtime documents.
      #
      # We don't `@vm&.dispose!` before swapping: per-visit rebuilds
      # happen on every spec example, and `dispose!` blocks on the
      # quickjs GC running with the GVL held. Ruby GC will eventually
      # reach the unreferenced VM and the gem's dfree handler frees
      # the JSRuntime. The transient C-heap growth between GCs is the
      # tradeoff for not paying ~hundreds of ms per spec.
      def rebuild_ctx
        @vm = build_vm
      end

      # Same operation as `rebuild_ctx` since per-visit rebuilds are
      # already the inter-test reset point.
      def reset_page = rebuild_ctx

      # NOTE: intentionally NO `dispose` — Browser#dispose gates its
      # `@runtime.dispose` call on `respond_to?(:dispose)`, so QuickJS skips it.
      # QuickJS VMs aren't pinned by a process-wide registry the way V8 isolates
      # are in V8Runtime's `@@live`; an aux window's Browser becomes unreferenced
      # on close and Ruby GC's dfree frees its `@vm` (the same lifecycle
      # `rebuild_ctx` already relies on). Adding a `@vm = nil` dispose would only
      # introduce a NoMethodError window for any stray post-close call (eval/call
      # don't all nil-guard `@vm`) with no leak benefit.

      # bridge.js patches `Intl.DateTimeFormat`; rusty_racer ships ICU built-in but
      # QuickJS gates it behind a polyfill flag (other surfaces bridge.js touches —
      # URL / TextEncoder / atob/btoa / crypto — already route through Ruby host fns,
      # so POLYFILL_INTL is the only one we strictly need).
      #
      # PERF (rule 3): quickjs is pinned to `~> 0.18.0` in the Gemfile. quickjs 0.19
      # both split the Intl polyfills into a separate quickjs-polyfill-intl gem (which
      # eval's them per VM at ~226 ms — vs this single bundled flag's ~140 ms) AND
      # regressed interpreter execution ~2.8× (measured: the QuickJS spec suite ran
      # 5.6 min on 0.18 vs 15.5 min on 0.19 with an equivalent Intl set). The 0.19
      # migration is recorded in the cross-window / quickjs-CI memory; re-migrate to
      # 0.19 + quickjs-polyfill-intl once that upstream perf regression is fixed.
      INTL_FEATURES = [Quickjs::POLYFILL_INTL].freeze
      #
      # `max_stack_size: 0` — `JS_SetMaxStackSize` measures C stack
      # delta from runtime construction; Ruby callers reach QuickJS
      # through deep stacks (Capybara `synchronize` + RSpec matchers +
      # bridge.js's class init closures), so the default 4 MB trips on
      # routine `check_stale → __csimAlive` calls. `0` disables the
      # check; OS thread stack is the real ceiling.
      #
      # `timeout_msec: (2**31)-1` — quickjs.rb default eval timeout is
      # 100 ms; bridge.js's `__csimEvaluateXPath` / `__csimDispatchEvent`
      # chains routinely exceed that on Avo-scale documents under
      # QuickJS's interpreter. 0 means "interrupt immediately" (the
      # handler returns `elapsed >= limit_ms`, so 0 fires on the first
      # check), so practical no-limit.
      VM_OPTIONS = {
        features:       INTL_FEATURES,
        max_stack_size: 0,
        # quickjs.rb's 128 MB default trips "out of memory in regexp
        # execution" on class-attribute-heavy polls and the heaviest
        # Mastodon hydrate (cumulative heap, not a single allocation).
        # 512 MB clears the ceiling without idle cost — `JS_SetMemoryLimit`
        # is a malloc ceiling, not a reservation.
        memory_limit:   512 * 1024 * 1024,
        # `drain_jobs!` loops `JS_ExecutePendingJob` until the
        # queue empties — but Forem's article-feed render schedules
        # new microtasks faster than they drain, so without a timer
        # the call never returns. Real per-spec eval rarely runs over
        # a second, and a 30 s ceiling is far below "hung CI worker"
        # while leaving headroom for the heaviest Mastodon hydrate.
        timeout_msec:   30_000
      }.freeze

      # Evaluates `url` as an ES module. For external `<script
      # type="module" src="…">`, pass `src=nil` so QuickJS goes through
      # `module_loader` to fetch — the URL becomes the module's
      # identity. For inline `<script type="module">{…}</script>`,
      # pass the body as `src` and let QuickJS compile it inline (the
      # synthesised `#inline-…` URL becomes the module's identity, but
      # transitive imports still go through `module_loader`).
      #
      # `quickjs.rb`'s `vm.import` distinguishes these by which keyword
      # arg you pass: `filename:` alone → loader fetch; `from:` alone →
      # inline compile. Passing both makes the gem ignore the body.
      def eval_esm_module(url, src = nil)
        v = vm
        opts = src ? { from: src.to_s } : { filename: url.to_s }
        opts[:code_to_expose] = ''
        v.import("* as __csim_entry_#{rand(1 << 32)}", **opts)
        v.drain_jobs!
      end

      private

      def vm
        @vm ||= build_vm
      end

      def build_vm
        v = self.class.pool.checkout
        @runnable.run(on: v)
        attach_host_fns(v)
        attach_module_loader(v)
        attach_rejection_tracker(v)
        v.eval_code('__csim_installWorker();')
        v
      end

      def attach_host_fns(v)
        self.class.attach_host_fns(v, @browser)
        # Re-enter the same VM to run the body. `Runnable` is portable
        # bytecode (no scope binding); replaying on `v` evaluates at
        # globalThis, matching `(0, eval)(body)` semantics that
        # bridge.js previously used directly. Script-throwing errors
        # propagate as JS exceptions for bridge.js's caller-side
        # try/catch.
        v.define_function('__csim_runScript') {|label, body|
          self.class.runnable_for(body.to_s, label).run(on: v)
          nil
        }
        # Native-ESM entry. `bridge.js`'s `runModuleScript` calls this
        # for every `<script type="module">`; V8 registers it too via
        # `V8Runtime#attach_native_module_loader`.
        browser = @browser
        v.define_function('__csim_evalEsmEntry') {|url, inline_src|
          RuntimeShared.safe_call { browser.eval_esm_module(url, inline_src) }
          nil
        }
      end

      # Class-level attach so Worker isolates (per-thread VMs that
      # don't have a Runtime instance) reuse the same host-fn table.
      def self.attach_host_fns(v, browser)
        RuntimeShared::BROWSER_HOST_FNS.each {|name, body|
          v.define_function(name) {|*a| RuntimeShared.safe_call { body.call(browser, *a) } }
        }
        RuntimeShared::STDLIB_HOST_FNS.each {|name, body|
          v.define_function(name, &body)
        }
        # `dispatchEventForUserAction` calls this between listener
        # invocations. `drain_jobs!` loops `JS_ExecutePendingJob` until
        # the queue is empty, matching V8's
        # `MicrotasksScope::PerformCheckpoint`. Older quickjs.rb
        # without `drain_jobs!` falls back to a no-op.
        if v.respond_to?(:drain_jobs!)
          v.define_function('__csim_yield') { v.drain_jobs!; nil }
        else
          v.define_function('__csim_yield') { nil }
        end
      end

      # Worker-isolate factory: fresh VM, bridge bytecode replayed,
      # host fns attached *after* the replay (so snapshot_stubs.js's
      # no-ops don't overwrite real ones), `__csim_isWorker` set, +
      # the per-worker postMessage routed through `post_back`.
      def self.build_worker(browser, post_back, broadcast_out = nil, sw_hooks = {})
        vm = Quickjs::VM.new(**VM_OPTIONS)
        bridge_runnable.run(on: vm)
        attach_host_fns(vm, browser)
        vm.define_function('__csim_workerPostMessage') {|data| post_back.call(data); nil }
        # A worker's BroadcastChannel fan-out routes through the thread-safe outbox, not
        # `browser.broadcast_to_windows` (cross-thread inbox mutation). See v8_runtime#build_worker.
        vm.define_function('__csimBroadcast') {|name, data, _rid, origin| broadcast_out&.call(name, data, origin); nil } if broadcast_out
        # Service-worker → main-thread signals via the outbox (see v8_runtime#build_worker).
        vm.define_function('__csim_swPostToClient') {|client_id, data| sw_hooks[:post_to_client]&.call(client_id, data); nil } if sw_hooks[:post_to_client]
        vm.define_function('__csim_swClaim') { sw_hooks[:claim]&.call; nil } if sw_hooks[:claim]
        vm.define_function('__csim_swFetchRespond') {|fetch_id, resp, realm_id| sw_hooks[:fetch_respond]&.call(fetch_id, resp, realm_id); nil } if sw_hooks[:fetch_respond]
        # Override main's __setTimersActive so worker's empty-timer-map
        # flip doesn't race main's `polling?` gate. See v8_runtime's
        # build_worker for the long-form rationale.
        vm.define_function('__setTimersActive') {|_flag| nil }
        # importScripts runs a classic script at top-level scope so its top-level
        # const/let/class share the realm's global lexical env (see v8_runtime).
        vm.define_function('__csim_workerImportEval') {|src| vm.eval_code(src.to_s); nil }
        vm.eval_code('__csim_installWorkerScope();')
        vm.drain_jobs!
        WorkerRuntime.new(
          eval_fn:           ->(s)     { v = vm.eval_code(s.to_s); vm.drain_jobs!; v },
          call_fn:           ->(n, *a) { v = vm.call(n.to_s, *a); vm.drain_jobs!; v },
          drain_microtasks:  ->        { vm.drain_jobs! },
          drain_timers:      ->        { vm.call('__drainTimers', 50) },
          has_ready_timer:   ->        { !!vm.call('__hasReadyTimer') },
          # quickjs.rb has no explicit dispose; GC reclaims the VM.
          dispose:           ->        { nil }
        )
      end

      # QuickJS's native ESM loader. The Ruby block returns the source
      # for each module URL; QuickJS handles parsing, live bindings,
      # `import.meta`, and `import()` natively. quickjs.rb 0.18 passes
      # the raw specifier + importer URL. Bare specifiers go through
      # `Browser#resolve_module_specifier` so importmap entries
      # (Stimulus / unbundled apps) resolve correctly; relative paths
      # resolve against the importer. `nil` from `rack_fetch_body`
      # propagates to QuickJS which raises a ReferenceError mirroring
      # a real-browser 404.
      def attach_module_loader(v)
        browser = @browser
        v.module_loader = ->(specifier, importer) {
          resolved = browser.resolve_module_specifier(specifier, importer)
          body = browser.rack_fetch_body(resolved)
          return nil unless body
          # `.json` (and `?import` JSON) imports come from Vite's
          # `import.meta.glob` and `import x from './data.json'`
          # patterns. quickjs.rb's loader passes the source through
          # `JS_EVAL_TYPE_MODULE` regardless of extension, so we wrap
          # JSON bodies in `export default …` ourselves. Real
          # browsers gate on `with { type: 'json' }`; Vite's bundler
          # output already injected that, but the resulting module
          # source is just the raw JSON so we need the wrap either way.
          code = resolved.to_s.match?(/\.json(?:\?|$)/) ? "export default #{body};" : body
          # Return `{ code:, as: }` so QuickJS caches by the resolved
          # absolute URL — necessary for subsequent relative imports
          # to use this URL as their importer, not the raw specifier.
          {code: code, as: resolved.to_s}
        }
      end

      # Funnel unhandled Promise rejections into `console.error` so
      # they show up in trace output / user-installed `log_console`
      # overrides. Without this, an async chain that rejects without
      # a `.catch` disappears silently — the same class of bug that
      # cost half a session debugging Intl.Collator (the throw fired
      # inside a module body we couldn't see).
      def attach_rejection_tracker(v)
        browser = @browser
        v.on_unhandled_rejection do |reason|
          msg = "#{reason.class}: #{reason.message}"
          stack = reason.backtrace&.any? ? "\n#{reason.backtrace.first(20).join("\n")}" : ''
          browser.log_console('error', "unhandled rejection: #{msg}#{stack}")
        end
      end

      # QuickJS marshals JS `undefined` as the symbol
      # `Quickjs::Value::UNDEFINED`; rusty_racer marshals it as `nil`. The
      # rest of the gem expects `nil`, so normalize at the boundary.
      # NaN gets the same treatment for consistency (the bridge never
      # surfaces it as a load-bearing value).
      UNDEFINED = Quickjs::Value::UNDEFINED
      NAN       = Quickjs::Value::NAN

      def normalize(value)
        case value
        when UNDEFINED, NAN then nil
        when Hash  then value.transform_values {|v| normalize(v) }
        when Array then value.map {|v| normalize(v) }
        else value
        end
      end
    end
  end
end
