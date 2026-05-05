require 'quickjs'
require 'set'

module Capybara
  module Simulated
    # QuickJS context wrapper. Owns the bridge that lets user JS read /
    # write the Nokogiri-backed DOM owned by `Browser`. Each DOM op
    # crosses into Ruby once; the JS side carries no DOM state of its
    # own — everything is a thin proxy keyed on integer handles.
    class JsRuntime
      VM_FEATURES = [
        Quickjs::POLYFILL_URL,
        Quickjs::POLYFILL_ENCODING,
        Quickjs::POLYFILL_CRYPTO
      ].freeze

      # 100 ms was too tight for cold jQuery boot under GC pressure
      # (~ 200 ms observed). 5_000 ms still surfaces a runaway timer
      # loop as InterruptedError.
      VM_TIMEOUT_MSEC = 5_000

      def initialize(browser)
        @browser = browser
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
      # of real time accumulate.
      def drain_timers(max_ms = nil)
        arg = max_ms.nil? ? '' : max_ms.to_i.to_s
        with_recycle { @vm.eval_code("__drainTimers(#{arg})") }
      end

      def reset_timers
        with_recycle { @vm.eval_code('__resetTimers()') }
      end

      def reset_page
        with_recycle do
          @vm.eval_code('__resetPage()')
          # Pump microtasks so the synthetic initial-scan records emitted
          # to surviving MutationObservers (Stimulus's BindingObserver
          # etc.) flush before the next page-bootstrap step runs. Without
          # this, controllers stay bound to the previous page's wrappers.
          pump_microtasks
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

      # Side-effect-only `import "URL"` as the module body — vm.import's
      # loader callback fetches the URL and runs it; the wrapper's empty
      # namespace export is unused.
      def eval_module_entry(url)
        with_recycle do
          @vm.import('* as __csim_unused', from: %[import #{url.to_json};])
          pump_microtasks
        end
      rescue Quickjs::RuntimeError, ArgumentError => e
        warn "[capybara-simulated] module #{url} failed: #{e.message[0, 200]}"
      end

      private

      def boot_vm
        @vm = Quickjs::VM.new(features: VM_FEATURES, timeout_msec: VM_TIMEOUT_MSEC)
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
      # one. 256 rounds drain Turbo Drive's POST→redirect→fetch→parse
      # →swap chain (~50 hops at peak) plus headroom — quiet pages
      # exit early because the awaited Promise resolves regardless,
      # so empty pumps are cheap.
      MICROTASK_PUMP_CODE = (('await null;' * 256) + 'void 0').freeze
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
        boot_vm
        yield
      rescue Quickjs::RuntimeError
        raise unless @vm.oom_poisoned?
        warn '[capybara-simulated] QuickJS VM hit OOM — recycling'
        boot_vm
        yield
      end

      # Wrap in `new Function` so `let`/`const` at the script's top
      # level land in a fresh function scope per invocation — re-running
      # the same body across page loads otherwise trips redeclaration
      # errors (QuickJS shares the eval scope across calls). The
      # `new Function` form also parses fewer wrapper nodes than
      # `eval('(function(){...})()')` and is gentler on QuickJS's
      # recursive-descent parser stack.
      # `;void 0` ensures the eval completion value is primitive —
      # to_rb_return_value raises ArgumentError on some object shapes
      # (e.g. jQuery's array-like wrappers).
      def eval_safely(code, label)
        return if code.nil? || code.empty?
        eval("new Function(#{code.to_json}).call(globalThis);#{MICROTASK_PUMP_CODE}")
      rescue Quickjs::RuntimeError, ArgumentError => e
        warn "[capybara-simulated] script #{label} failed: #{e.message[0, 200]}"
      end

      def attach_dom_bridge
        @vm.define_function('__dom') do |handle, op, args|
          @browser.dom_op(handle, op, args || [])
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
        @vm.on_log do |level, *parts|
          warn "[capybara-simulated console.#{level}] #{parts.map(&:to_s).join(' ')}"
        end
      end
    end
  end
end
