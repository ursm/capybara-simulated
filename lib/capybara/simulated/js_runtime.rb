# frozen_string_literal: true

require 'quickjs'
require 'set'

module Capybara
  module Simulated
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
      # The default 4 MiB limit measures the difference between the
      # current C-stack pointer and the one captured when the runtime
      # was constructed — but Capybara enters JS through deep Ruby
      # frames (matcher → `Node#visible?` → `check_stale` →
      # `drain_timers`), and Ruby↔JS↔Ruby ping-pongs from `__dom`
      # callbacks deepen it further mid-drain. With the captured
      # `stack_top` set when Ruby was shallow, the parser's
      # `js_check_stack_overflow` trips on the first token of even a
      # tiny eval like `__drainTimers(N)` and the VM is recycled,
      # losing the in-flight setTimeouts. Disabling the check trades
      # a runaway-recursion safety net (Capybara already enforces a
      # 5_000 ms `timeout_msec`) for stable wait-style polling.
      VM_OPTIONS = {
        timeout_msec:   5_000,
        memory_limit:   512 * 1024 * 1024,
        max_stack_size: 0
      }.freeze

      def initialize(browser, extra_features: [])
        @browser              = browser
        @features             = (DEFAULT_FEATURES + extra_features).uniq.freeze
        @recycled_since_reset = false
        boot_vm
      end

      BRIDGE_JS = File.expand_path('../../../vendor/js/bridge.js', __dir__).freeze

      def eval(code)
        with_recycle { @vm.eval_code(code.to_s) }
      end

      # Pumping microtasks after every call is needed because js_std_await
      # only drains while the awaited Promise is pending — synchronous
      # JS functions (__fireLifecycle, etc.) leave .then callbacks queued
      # otherwise.
      def call(name, *args)
        with_recycle do
          result = @vm.call(name, *args)
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
          @vm.eval_code("__drainTimers(#{arg})")
          pump_microtasks
        end
      end

      def reset_timers
        with_recycle { @vm.eval_code('__resetTimers()') }
      end

      def reset_page
        # Boot a fresh VM whenever the previous test either hit a recycle
        # (post-recycle state is indeterminate) or evaluated user scripts
        # at top level (top-level `let` / `const` declarations are stuck
        # in the global lexical environment until the runtime is rebuilt,
        # and re-evaluating the same fixture in the next test would trip
        # a redeclaration SyntaxError).
        if @recycled_since_reset || @scripts_evaluated_since_reset
          boot_vm
          @recycled_since_reset = false
          @scripts_evaluated_since_reset = false
          return
        end
        # Pump microtasks only when __resetPage actually queued an
        # initial-scan record — fresh-page bootstrap doesn't need a
        # 256-round drain otherwise.
        with_recycle do
          pending = @vm.eval_code('__resetPage()')
          pump_microtasks if pending && pending > 0
        end
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
          @vm.import('* as __csim_unused', filename: url)
          pump_microtasks
        end
      rescue Quickjs::RuntimeError, ArgumentError => e
        warn "[capybara-simulated] module #{url} failed: #{e.message[0, 200]}"
      end

      private

      def boot_vm
        @vm = Quickjs::VM.new(features: @features, **VM_OPTIONS)
        attach_dom_bridge
        # Receives the already-absolute, importmap-resolved URL we
        # rewrote into the source on a prior pass. Browser#load_module
        # fetches via Rack and rewrites this module's own nested
        # specifiers so they come back here as URLs too.
        @vm.module_loader = ->(name) { @browser.load_module(name) }
        @vm.eval_code(File.read(BRIDGE_JS))
      end

      # `await null` resumes via a microtask, and JS_EVAL_FLAG_ASYNC's
      # js_std_await pumps the QuickJS pending-job queue between each
      # one. 64 rounds covers Turbo Drive's deepest observed chain (~50)
      # with headroom; empty pumps still cost ~30µs, so don't oversize.
      MICROTASK_PUMP_CODE = (('await null;' * 64) + 'void 0').freeze
      def pump_microtasks
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
        recycle!
        yield
      rescue Quickjs::RuntimeError
        raise unless @vm.oom_poisoned?
        warn '[capybara-simulated] QuickJS VM hit OOM — recycling'
        recycle!
        yield
      end

      def recycle!
        boot_vm
        @recycled_since_reset = true
      end

      # Run user scripts at top level so `function foo() {}` / `var foo`
      # at the script's top level become globals — a real browser does
      # the same and a lot of legacy code (jQuery plugins, Redmine's
      # application-legacy bundle, …) leans on it.
      #
      # Caveat: `let` / `const` at top level write to the global lexical
      # environment, which QuickJS shares across eval calls. Re-running
      # the same body after a navigation trips a SyntaxError on the
      # redeclaration; warn and move on rather than fail the whole page.
      # The `boot_vm`-on-recycle path resets the lexical env when it
      # really matters; modules go through `vm.import` and aren't
      # affected.
      def eval_safely(code, label)
        return if code.nil? || code.empty?
        @scripts_evaluated_since_reset = true
        with_recycle { @vm.eval_code(code, filename: label) }
      rescue Quickjs::SyntaxError => e
        return if e.message.match?(/has already been declared/)
        warn "[capybara-simulated] script #{label} failed: #{e.message[0, 200]}"
      rescue Quickjs::RuntimeError, ArgumentError => e
        warn "[capybara-simulated] script #{label} failed: #{e.message[0, 200]}"
      end

      EMPTY_ARGS = [].freeze

      def attach_dom_bridge
        @vm.define_function('__dom') do |handle, op, args|
          @browser.dom_op(handle, op, args || EMPTY_ARGS)
        end
        @vm.define_function('__notifyMutationActive') do |active|
          @browser.mutation_recording = !!active
        end
        @vm.define_function('__setListenedType') do |type, active|
          @browser.set_listened_type(type, !!active)
        end
        @vm.define_function('__setTimersActive') do |active|
          @browser.timers_active = !!active
        end
        @vm.define_function('__modalDialog') do |type, message, default_value|
          @browser.handle_modal(type, message, default_value)
        end
        @vm.define_function('__setCurrentUrl') do |url|
          @browser.history_state(url)
        end
        @vm.define_function('__locationAssign') do |url|
          @browser.location_assign(url)
        end
        @vm.define_function('__locationReload') do
          @browser.refresh
        end
        @vm.define_function('__rackFetch') do |method, url, body, headers, redirect_mode|
          @browser.rack_fetch(method, url, body, headers, redirect_mode)
        end
        # quickjs.rb yields a single Quickjs::VM::Log; `to_s` already
        # joins the args and expands JS Error objects with their stack
        # trace, so surfacing it directly is more useful than splatting.
        @vm.on_log do |log|
          warn "[capybara-simulated console.#{log.severity}] #{log}"
        end
      end
    end
  end
end
