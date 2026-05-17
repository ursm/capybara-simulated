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

require 'quickjs'

require_relative 'runtime_shared'

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
        v.drain_microtasks!
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
      # `drain_microtasks!` (quickjs.rb 0.18+) wraps
      # `JS_ExecutePendingJob` in a loop to empty the queue, bounded
      # by the VM's `timeout_msec`.
      def call(name, *args)
        v = vm
        result = v.call(name.to_s, *args)
        v.drain_microtasks!
        normalize(result)
      end

      # bridge.js owns the virtual clock; we drive it from Ruby because
      # Capybara's polling cadence is wall-clock-anchored.
      def drain_timers(max_ms = nil)
        max_ms.nil? ? vm.call('__drainTimers') : vm.call('__drainTimers', max_ms.to_i)
      end

      # `iters` is ignored: `drain_microtasks!` already loops until
      # the queue is empty, so repeating drains nothing extra. The
      # arity matches V8Runtime so `Browser#settle` can call either
      # without engine-switching.
      def drain_microtasks(_iters = 4)
        vm.drain_microtasks!
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
      # Note: quickjs.rb 0.17.0.pre doesn't expose `VM#dispose`, so
      # the previous VM's C-side `JSRuntime` is reclaimed only via
      # Ruby GC (its dfree handler calls `JS_FreeRuntime`). Long
      # parallel workers see transient C-heap growth proportional to
      # the rebuild rate; one upstream PR away from V8Runtime's
      # explicit background-thread teardown.
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
        timeout_msec:   (2**31) - 1
      }.freeze

      private

      def vm
        @vm ||= build_vm
      end

      def build_vm
        v = self.class.pool.checkout
        @runnable.run(on: v)
        attach_host_fns(v)
        v
      end

      def attach_host_fns(v)
        browser = @browser
        RuntimeShared::BROWSER_HOST_FNS.each {|name, body|
          v.define_function(name) {|*a| RuntimeShared.safe_call { body.call(browser, *a) } }
        }
        RuntimeShared::STDLIB_HOST_FNS.each {|name, body|
          v.define_function(name, &body)
        }
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
