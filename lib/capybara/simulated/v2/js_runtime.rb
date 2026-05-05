require 'quickjs'
require 'set'

module Capybara
  module Simulated
    module V2
      # QuickJS context wrapper. Owns the bridge that lets user JS read /
      # write the Nokogiri-backed DOM owned by `Browser`. Each ↔ DOM op
      # crosses into Ruby once; the JS side carries no DOM state of its
      # own — everything is a thin proxy keyed on integer handles.
      class JsRuntime
        # Pull in the polyfills the quickjs gem ships that real browser
        # environments expect — URL / URLSearchParams, TextEncoder /
        # TextDecoder, crypto.getRandomValues / randomUUID / subtle. Cheap
        # at boot, removes "X is not defined" failures during library load.
        VM_FEATURES = [
          Quickjs::POLYFILL_URL,
          Quickjs::POLYFILL_ENCODING,
          Quickjs::POLYFILL_CRYPTO
        ].freeze

        # 100 ms is too tight for cold jQuery boot under GC pressure (~ 200 ms
        # observed when the heap is under stress). Bump high enough that a
        # legitimately runaway timer loop still surfaces as InterruptedError.
        VM_TIMEOUT_MSEC = 5_000

        def initialize(browser)
          @browser = browser
          boot_vm
        end

        BRIDGE_JS = File.expand_path('../../../../vendor/js/v2_bridge.js', __dir__).freeze

        # When QuickJS hits an unrecoverable OOM, quickjs.rb (>= the OOM-
        # poison patch) marks the VM as poisoned — every subsequent call
        # raises Quickjs::RuntimeError. `with_recycle` catches that, and
        # if `vm.oom_poisoned?` confirms the cause it rebuilds the VM and
        # re-runs the operation once. Browser fully re-bootstraps the JS
        # side on the next navigate (reset_page + run_scripts), so the
        # caller doesn't lose state. Long Capybara suites (~hundreds of
        # /with_js visits each loading ~200 KB of scripts) trip this
        # without the recycle.
        def eval(code)
          with_recycle { @vm.eval_code(code.to_s) }
        end

        # Direct call into a globalThis function — quickjs.rb 0.13+ added
        # this; cheaper than building a JS source string and re-parsing,
        # arguments cross natively without JSON.dump.
        def call(name, *args)
          with_recycle { @vm.call(name, *args) }
        end

        # Advance the virtual clock until the timer queue is empty (or the
        # cap trips). Called by Browser after every user-driven action so
        # that setTimeout / requestAnimationFrame work has settled before
        # the next assertion.
        def drain_timers
          with_recycle { @vm.eval_code('__drainTimers()') }
        end

        def reset_timers
          with_recycle { @vm.eval_code('__resetTimers()') }
        end

        # Wipe all per-page state — listeners, observers, custom-element
        # instances, timer queue. Handle integers get reused across docs,
        # so leftover JS state would alias the wrong nodes after navigate.
        def reset_page
          with_recycle { @vm.eval_code('__resetPage()') }
        end

        SCRIPT_TYPES_RUNNABLE = Set['', 'text/javascript', 'application/javascript', 'application/ecmascript'].freeze

        # Run every classic `<script>` in document order — both inline and
        # external `src=...`. The caller supplies a fetcher block that
        # resolves a `src` attr to its body text (or nil to skip). Async /
        # defer hints are honoured implicitly because everything runs
        # synchronously in document order. `type="module"` is skipped.
        def run_scripts(document)
          document.css('script').each do |script|
            type = script['type'].to_s
            next unless SCRIPT_TYPES_RUNNABLE.include?(type)
            if (src = script['src']) && !src.empty?
              body = yield(src)
              next if body.nil?
              eval_safely(body, src)
            else
              eval_safely(script.text, '<inline>')
            end
          end
        end

        private

        def boot_vm
          @vm = Quickjs::VM.new(features: VM_FEATURES, timeout_msec: VM_TIMEOUT_MSEC)
          attach_dom_bridge
          @vm.eval_code(File.read(BRIDGE_JS))
        end

        # Detect the OOM-poisoned state from PR hmsk/quickjs.rb#23 (typed
        # via `vm.oom_poisoned?`) and rebuild the VM. Other Quickjs errors
        # propagate — Browser handles JS-runtime exceptions per call site.
        def with_recycle
          yield
        rescue Quickjs::RuntimeError
          raise unless @vm.respond_to?(:oom_poisoned?) && @vm.oom_poisoned?
          warn '[capybara-simulated/v2] QuickJS VM hit OOM — recycling'
          boot_vm
          yield
        end

        def eval_safely(code, label)
          return if code.nil? || code.empty?
          # Append `;void 0` so the expression-statement's completion value
          # is always primitive — the quickjs gem's to_rb_return_value
          # raises ArgumentError("NULL pointer given") on some object shapes
          # (e.g. jQuery's array-like wrappers). We don't use the return
          # value of a `<script>` block anyway.
          eval("#{code}\n;void 0")
        rescue Quickjs::RuntimeError, ArgumentError => e
          warn "[capybara-simulated/v2] script #{label} failed: #{e.message[0, 200]}"
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
          @vm.on_log do |level, *parts|
            warn "[capybara-simulated/v2 console.#{level}] #{parts.map(&:to_s).join(' ')}"
          end
        end
      end
    end
  end
end
