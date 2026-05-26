# frozen_string_literal: true

# QuickJS-backed Runtime, alternate to `V8Runtime`. The DOM still lives
# in JS (same bridge.js, same wgxpath); this class swaps the engine to
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
      # Compile bridge.js + wgxpath into bytecode once per process. Every
      # per-visit VM replays this in ~10–20 ms (PR 31's microbench: 504KB
      # bundle in ~4 ms; bridge.js + wgxpath is ~10× larger). Side
      # effects (class definitions, `wgxpath.install(globalThis)`) run on
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

      # mini_racer's `Context#call` drains the V8 microtask queue at
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

      # bridge.js owns the virtual clock; we drive it from Ruby because
      # Capybara's polling cadence is wall-clock-anchored.
      def drain_timers(max_ms = nil)
        max_ms.nil? ? vm.call('__drainTimers') : vm.call('__drainTimers', max_ms.to_i)
      end

      # `iters` is ignored — `drain_jobs!` already loops to queue-empty,
      # so further rounds drain nothing extra. The arity matches
      # `V8Runtime#drain_microtasks` so `Browser#settle` can call either
      # engine's method without branching.
      def drain_microtasks(_iters = 4)
        vm.drain_jobs!
      end

      def settle_gen
        vm.call('__settleGenGet').to_i
      end

      def has_ready_timer?
        return false if @vm.nil?
        !!vm.call('__hasReadyTimer')
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

      # bridge.js patches `Intl.DateTimeFormat`; mini_racer ships ICU
      # built-in but QuickJS gates it behind a polyfill flag. Other JS
      # surfaces bridge.js touches (URL / TextEncoder / atob/btoa /
      # crypto) are already routed through Ruby-side host fns, so
      # POLYFILL_INTL is the only one we strictly need.
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
        features:       [Quickjs::POLYFILL_INTL].freeze,
        max_stack_size: 0,
        # quickjs.rb's 128 MB default trips "out of memory in regexp
        # execution" inside wgxpath's `normalize-space` on class-
        # attribute-heavy polls (cumulative heap, not a single
        # allocation). 512 MB clears the ceiling without idle cost —
        # `JS_SetMemoryLimit` is a malloc ceiling, not a reservation.
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
        # if it's defined; presence is the engine-capability signal.
        # The V8 runtime doesn't register it, so bridge.js falls back
        # to its JS-side `__csim_require` + EsmRewriter loader there.
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
      end

      # Worker-isolate factory: fresh VM, bridge bytecode replayed,
      # host fns attached *after* the replay (so snapshot_stubs.js's
      # no-ops don't overwrite real ones), `__csim_isWorker` set, +
      # the per-worker postMessage routed through `post_back`.
      def self.build_worker(browser, post_back)
        vm = Quickjs::VM.new(**VM_OPTIONS)
        bridge_runnable.run(on: vm)
        attach_host_fns(vm, browser)
        vm.define_function('__csim_workerPostMessage') {|data| post_back.call(data); nil }
        # Override main's __setTimersActive so worker's empty-timer-map
        # flip doesn't race main's `polling?` gate. See v8_runtime's
        # build_worker for the long-form rationale.
        vm.define_function('__setTimersActive') {|_flag| nil }
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
      # `import.meta`, and `import()` natively — no `EsmRewriter`,
      # no `__csim_liveImport` Proxy approximation, no column drift.
      # quickjs.rb 0.18 passes the raw specifier + importer URL.
      # Bare specifiers go through `Browser#resolve_module_specifier`
      # so importmap entries (Stimulus / unbundled apps) resolve
      # correctly; relative paths resolve against the importer. `nil`
      # from `rack_fetch_body` propagates to QuickJS which raises a
      # ReferenceError mirroring a real-browser 404.
      def attach_module_loader(v)
        browser = @browser
        v.module_loader = ->(specifier, importer) {
          resolved = browser.send(:resolve_module_specifier, specifier, importer)
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
      # `Quickjs::Value::UNDEFINED`; mini_racer marshals it as `nil`. The
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
