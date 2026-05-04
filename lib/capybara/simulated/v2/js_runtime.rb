require 'quickjs'

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

        def initialize(browser)
          @browser = browser
          @vm      = Quickjs::VM.new(features: VM_FEATURES)
          attach_dom_bridge
          @vm.eval_code(File.read(BRIDGE_JS))
        end

        BRIDGE_JS = File.expand_path('../../../../vendor/js/v2_bridge.js', __dir__).freeze

        def eval(code)
          @vm.eval_code(code.to_s)
        end

        # Direct call into a globalThis function — quickjs.rb 0.13+ added
        # this; cheaper than building a JS source string and re-parsing,
        # arguments cross natively without JSON.dump.
        def call(name, *args)
          @vm.call(name, *args)
        end

        # Advance the virtual clock until the timer queue is empty (or the
        # cap trips). Called by Browser after every user-driven action so
        # that setTimeout / requestAnimationFrame work has settled before
        # the next assertion.
        def drain_timers
          @vm.eval_code('__drainTimers()')
        end

        def reset_timers
          @vm.eval_code('__resetTimers()')
        end

        # Wipe all per-page state — listeners, observers, custom-element
        # instances, timer queue. Handle integers get reused across docs,
        # so leftover JS state would alias the wrong nodes after navigate.
        def reset_page
          @vm.eval_code('__resetPage()')
        end

        SCRIPT_TYPES_RUNNABLE = ['', 'text/javascript', 'application/javascript', 'application/ecmascript'].freeze

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

        def eval_safely(code, label)
          return if code.nil? || code.empty?
          # Append `;void 0` so the expression-statement's completion value
          # is always primitive — the quickjs gem's to_rb_return_value
          # raises ArgumentError("NULL pointer given") on some object shapes
          # (e.g. jQuery's array-like wrappers). We don't use the return
          # value of a `<script>` block anyway.
          @vm.eval_code("#{code}\n;void 0")
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
          @vm.on_log do |level, *parts|
            warn "[capybara-simulated/v2 console.#{level}] #{parts.map(&:to_s).join(' ')}"
          end
        end
      end
    end
  end
end
