# frozen_string_literal: true

require 'quickjs'
require 'set'

module Capybara
  module Simulated
    # Pre-warmed pool of `Quickjs::VM` instances. `Quickjs::VM.new` with
    # `POLYFILL_INTL` is ~140 ms (FormatJS locale tables + IANA TZ
    # bytecode); quickjs.rb#36 releases the GVL throughout, so warmer
    # threads build in parallel.
    class VmPool
      # 4 warmers × ~140 ms/build ≈ 28 VMs/sec — covers sustained demand
      # for shared-spec-shaped runs (~16 tests/sec at peak). Capacity
      # buffers short bursts before warmers backfill; larger capacity
      # only matters under parallel-test runners we don't support.
      WARMER_COUNT = 4
      CAPACITY     = 6

      def initialize(features, vm_options)
        @features   = features
        @vm_options = vm_options
        @queue      = SizedQueue.new(CAPACITY)
        @threads    = WARMER_COUNT.times.map do |i|
          Thread.new { warmer_loop }.tap {|t| t.name = "csim-vm-warmer-#{i}" }
        end
      end

      def checkout = @queue.pop

      # `at_exit` hook: SEGV if a warmer is mid-`Quickjs::VM.new` (GVL
      # released, inside QuickJS C) when Ruby starts tearing itself down.
      def shutdown
        @queue.close
        @threads.each {|t| t.join(2) }
      end

      private

      def warmer_loop
        loop { @queue.push(Quickjs::VM.new(features: @features, **@vm_options)) }
      rescue ClosedQueueError
        # process exit
      end
    end

    # QuickJS context wrapper. Owns the bridge that lets user JS read /
    # write the Nokogiri-backed DOM owned by `Browser`. Each DOM op
    # crosses into Ruby once; the JS side carries no DOM state of its
    # own — everything is a thin proxy keyed on integer handles.
    class JsRuntime
      # The minimum surface a Hotwire-shaped browser needs: URL parsing,
      # TextEncoder/Decoder, and crypto.randomUUID (Turbo stream IDs).
      # Apps that need Intl, Blob/File, etc. add to it via
      # Driver.new(app, features: [...]).
      #
      # 100 ms was too tight for cold jQuery boot under GC pressure
      # (~ 200 ms observed). 5_000 ms still surfaces a runaway timer
      # loop as InterruptedError.
      #
      # 128 MiB (the gem's memory_limit default) OOMs under sustained
      # jQuery + jQuery UI loads; 512 MiB removes the trigger.
      DEFAULT_FEATURES = [
        Quickjs::POLYFILL_URL,
        Quickjs::POLYFILL_ENCODING,
        Quickjs::POLYFILL_CRYPTO,
        # Bundled apps (Avo's flatpickr, luxon-driven date pickers, etc.)
        # reach for `Intl.DateTimeFormat` during module init; without it
        # the controller-connect path throws and the rest of the
        # bundle's controllers never register.
        Quickjs::POLYFILL_INTL
      ].freeze
      # `max_stack_size: 0` disables QuickJS' C-stack overflow check.
      # The check uses the `stack_top` captured at runtime construction
      # (Ruby was shallow), so re-entering JS from a deep Capybara
      # matcher chain trips it on tiny evals and recycles the VM —
      # losing in-flight setTimeouts mid-test. `timeout_msec` is the
      # remaining backstop against runaway recursion.
      VM_OPTIONS = {
        timeout_msec:   5_000,
        memory_limit:   512 * 1024 * 1024,
        max_stack_size: 0
      }.freeze

      # Pool registry, keyed by feature set so that `extra_features:`
      # callers don't share a pool with default-feature ones (the warmed
      # VMs would have the wrong polyfills loaded).
      @@pools_lock = Mutex.new
      @@pools      = {}

      def self.pool_for(features)
        @@pools_lock.synchronize {
          @@pools[features] ||= VmPool.new(features, VM_OPTIONS)
        }
      end

      at_exit do
        @@pools_lock.synchronize { @@pools.each_value(&:shutdown) }
      rescue StandardError
        # Ruby already mid-shutdown; best-effort.
      end

      def initialize(browser, extra_features: [])
        @browser  = browser
        @features = (DEFAULT_FEATURES + extra_features).uniq.freeze
        @pool     = self.class.pool_for(@features)
      end

      BRIDGE_JS = File.expand_path('../../../vendor/js/bridge.js', __dir__).freeze

      def eval(code)
        with_recycle { vm.eval_code(code.to_s) }
      end

      # Pumping microtasks after every call is needed because js_std_await
      # only drains while the awaited Promise is pending — synchronous
      # JS functions (__fireLifecycle, etc.) leave .then callbacks queued
      # otherwise.
      def call(name, *args)
        with_recycle do
          result = vm.call(name, *args)
          pump_microtasks
          result
        end
      end

      # `max_ms = 0` fires only currently-due timers (microtasks);
      # passing the elapsed wall time lets `setTimeout(N)` fire as N ms
      # of real time accumulate. Pump microtasks afterwards so any
      # `Promise.then(...)` queued by a timer callback (e.g. Turbo's
      # FrameRenderer chain that does `await nextRepaint()` between
      # parsing and committing the swap) resumes before settle's next
      # buffer-empty check, instead of stranding the trailing
      # `appendChild` mutation in `@mutations` until reset.
      def drain_timers(max_ms = nil)
        arg = max_ms.nil? ? '' : max_ms.to_i.to_s
        with_recycle do
          vm.eval_code("__drainTimers(#{arg})")
          pump_microtasks
        end
      end

      # True when a timer is queued with due <= virtualNow — i.e. a
      # setTimeout(0) (commonly scheduled inside a Promise microtask
      # that ran AFTER the prior drain_timers finished firing
      # timers). Settle keeps iterating while this returns true so
      # post-microtask setTimeout(0) chains drain in the same call,
      # but a lone setInterval / rAF doesn't keep us pegged.
      # No VM = no queued timers; skip the pool checkout.
      def has_ready_timer?
        return false if @vm.nil?
        with_recycle { @vm.eval_code('!!__hasReadyTimer()') }
      end

      def reset_timers
        return if @vm.nil?
        with_recycle { @vm.eval_code('__resetTimers()') }
      end

      # Real-browser parity: every navigation gets a fresh JS context.
      # Top-level `let`/`const`/`class`, the module-import-cache, and
      # accumulated `document.addEventListener` registrations all
      # vanish with the old VM. Nilling the slot rather than checking
      # out eagerly means a Browser that's reset and then discarded
      # without further use (the common test-boundary pattern) costs
      # zero pool builds.
      def reset_page
        @vm = nil
      end

      SCRIPT_TYPES_CLASSIC = Set['', 'text/javascript', 'application/javascript', 'application/ecmascript'].freeze

      def run_scripts(browser, document)
        document.css('script').each do |script|
          case script['type'].to_s
          when 'module'    then run_module_script(browser, script)
          when 'importmap' then next # consumed by Browser#ingest_importmaps
          else
            run_classic_script(browser, script) if SCRIPT_TYPES_CLASSIC.include?(script['type'].to_s)
          end
        end
      end

      def run_classic_script(browser, script)
        src = script['src']
        if src && !src.empty?
          body = browser.fetch_resource(browser.resolve(src))
          eval_safely(body, src) if body
        else
          eval_safely(script.text, '<inline>')
        end
      end

      def run_module_script(browser, script)
        # Modules evaluate exactly once per VM (QuickJS keeps them in its
        # module table forever), so any module side-effect — `Application.start()`,
        # `customElements.define`, top-level `let` — pins state we'd
        # otherwise want fresh on the next page. The unconditional
        # boot_vm in `reset_page` (one VM per navigation) makes this a
        # non-issue: every page load lands on a clean module graph.
        src = script['src']
        if src && !src.empty?
          url = browser.resolve(src)
          # Pre-warm the cache so the loader callback doesn't re-fetch.
          browser.load_module(url) or return
          eval_module_entry(url)
        else
          inline = script.text.to_s
          return if inline.strip.empty?
          # Synthesise a deterministic URL so re-evaluating the same body
          # (after a VM recycle) hits the cached rewrite.
          url = browser.resolve('inline-module-' + Digest::SHA256.hexdigest(inline)[0, 16] + '.mjs')
          browser.cache_inline_module(url, inline)
          eval_module_entry(url)
        end
      end

      # Resolve `url` straight through the module loader — quickjs.rb #30
      # added the `filename:` shortcut so we don't have to compile a
      # one-line `import "URL";` bridge module just to side-effect-load.
      # The `* as __csim_unused` namespace is unused.
      def eval_module_entry(url)
        with_recycle do
          vm.import('* as __csim_unused', filename: url)
          pump_microtasks
        end
      rescue Quickjs::RuntimeError, ArgumentError => e
        warn "[capybara-simulated] module #{url} failed: #{e.message[0, 200]}"
      end

      private

      def vm
        @vm ||= boot_vm
      end

      def boot_vm
        v = @pool.checkout
        attach_dom_bridge_to(v)
        # Browser#load_module fetches via Rack and rewrites the module's
        # nested specifiers to absolute URLs before they come back here.
        v.module_loader = ->(name) { @browser.load_module(name) }
        bridge_runnable(v).run(on: v)
        @vm = v
      end

      # The wrapped bytecode is portable across QuickJS runtimes, so
      # bridge.js parses once per process; every subsequent `boot_vm`
      # just replays. The benign double-compile race on first call is
      # tolerated for the same reason `@@runnable_cache` (below) does:
      # both candidates produce equivalent `Runnable`s.
      @@bridge_runnable = nil
      def bridge_runnable(vm)
        @@bridge_runnable ||= vm.compile(File.read(BRIDGE_JS), filename: BRIDGE_JS)
      end

      # `await null` resumes via a microtask, and JS_EVAL_FLAG_ASYNC's
      # js_std_await pumps the QuickJS pending-job queue between each
      # one. 64 rounds covers Turbo Drive's deepest observed chain (~50)
      # with headroom; empty pumps still cost ~30µs, so don't oversize.
      MICROTASK_PUMP_CODE = (('await null;' * 64) + 'void 0').freeze
      # `@vm` may be nil if the call yielding to us triggered a
      # navigation that nilled the slot via `reset_page`. The fresh VM
      # has no microtasks queued — nothing to pump.
      def pump_microtasks
        return if @vm.nil?
        @vm.eval_code(MICROTASK_PUMP_CODE)
      end

      # Detect the OOM-poisoned state from PR hmsk/quickjs.rb#23 (typed
      # via `vm.oom_poisoned?`) and rebuild the VM. Also catch the
      # parser-stack overflow QuickJS reports as a SyntaxError at
      # `<vm>:1:1` under sustained allocation — same fix (fresh VM).
      # Other Quickjs errors propagate so call sites can decide.
      def with_recycle
        yield
      rescue Quickjs::SyntaxError => e
        raise unless e.message.include?('stack overflow')
        warn '[capybara-simulated] QuickJS parser stack overflow — recycling VM'
        boot_vm
        yield
      rescue Quickjs::RuntimeError
        raise if @vm.nil? || !@vm.oom_poisoned?
        warn '[capybara-simulated] QuickJS VM hit OOM — recycling'
        boot_vm
        yield
      end

      # Compiled-`Runnable` cache shared across every JsRuntime / VM in
      # this process. The wrapped QuickJS bytecode is portable between
      # runtimes (per `quickjs.rb`'s `Runnable#run(on:)` contract), so
      # the same Avo / Rails bundle parses once and replays on every
      # page load and every VM rebuild — the parse step dominated
      # eval_safely (10.8s out of a 23.5s Avo slice).
      @@runnable_cache = {}

      def eval_safely(code, label)
        return if code.nil? || code.empty?
        runnable = (@@runnable_cache[code.hash] ||= compile_safely(code, label))
        return unless runnable
        with_recycle { runnable.run(on: vm) }
      rescue Quickjs::SyntaxError => e
        return if e.message.match?(/has already been declared/)
        warn "[capybara-simulated] script #{label} failed: #{e.message[0, 200]}"
      rescue Quickjs::RuntimeError, ArgumentError => e
        warn "[capybara-simulated] script #{label} failed: #{e.message[0, 200]}"
      end

      def compile_safely(code, label)
        with_recycle { vm.compile(code, filename: label) }
      rescue Quickjs::SyntaxError => e
        warn "[capybara-simulated] script #{label} failed to compile: #{e.message[0, 200]}"
        nil
      end

      EMPTY_ARGS = [].freeze

      def attach_dom_bridge_to(vm)
        vm.define_function('__dom') do |handle, op, args|
          @browser.dom_op(handle, op, args || EMPTY_ARGS)
        end
        vm.define_function('__addMutationObserverId') do |id|
          @browser.add_mutation_observer_id(id.to_i)
        end
        vm.define_function('__removeMutationObserverId') do |id|
          @browser.remove_mutation_observer_id(id.to_i)
        end
        vm.define_function('__setListenedType') do |type, active|
          @browser.set_listened_type(type, !!active)
        end
        vm.define_function('__setTimersActive') do |active|
          @browser.timers_active = !!active
        end
        vm.define_function('__modalDialog') do |type, message, default_value|
          @browser.handle_modal(type, message, default_value)
        end
        vm.define_function('__setCurrentUrl') do |url|
          @browser.history_state(url)
        end
        vm.define_function('__locationAssign') do |url|
          @browser.location_assign(url)
        end
        vm.define_function('__locationReload') do
          @browser.refresh
        end
        vm.define_function('__rackFetch') do |method, url, body, headers, redirect_mode|
          @browser.rack_fetch(method, url, body, headers, redirect_mode)
        end
        vm.define_function('__getDocumentCookie') do
          @browser.document_cookie
        end
        vm.define_function('__setDocumentCookie') do |line|
          @browser.write_document_cookie(line.to_s)
        end
        # quickjs.rb yields a single Quickjs::VM::Log; `to_s` already
        # joins the args and expands JS Error objects with their stack
        # trace, so surfacing it directly is more useful than splatting.
        vm.on_log do |log|
          warn "[capybara-simulated console.#{log.severity}] #{log}"
          @browser.trace&.log_console(log.severity, log.to_s)
        end
      end
    end
  end
end
