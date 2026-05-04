require 'quickjs'

module Capybara
  module Simulated
    module V2
      # QuickJS context wrapper. Owns the bridge that lets user JS read /
      # write the Nokogiri-backed DOM owned by `Browser`. Each ↔ DOM op
      # crosses into Ruby once; the JS side carries no DOM state of its
      # own — everything is a thin proxy keyed on integer handles.
      class JsRuntime
        def initialize(browser)
          @browser = browser
          @vm      = Quickjs::VM.new
          attach_dom_bridge
          @vm.eval_code(File.read(BRIDGE_JS))
        end

        BRIDGE_JS = File.expand_path('../../../../vendor/js/v2_bridge.js', __dir__).freeze

        def eval(code)
          @vm.eval_code(code.to_s)
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

        # Run every inline `<script>` in document order. External `src`
        # scripts and `type="module"` are skipped here — those land in
        # later phases.
        def run_inline_scripts(document)
          document.css('script').each do |script|
            next if script['src']
            next if script['type'] && script['type'] != 'text/javascript' && script['type'] != ''
            begin
              @vm.eval_code(script.text)
            rescue Quickjs::RuntimeError => e
              warn "[capybara-simulated/v2] inline script failed: #{e.message[0, 200]}"
            end
          end
        end

        private

        def attach_dom_bridge
          @vm.define_function('__dom') do |handle, op, args|
            @browser.dom_op(handle, op, args || [])
          end
          @vm.define_function('__notifyMutationActive') do |active|
            @browser.mutation_recording = !!active
          end
          @vm.on_log do |level, *parts|
            warn "[capybara-simulated/v2 console.#{level}] #{parts.map(&:to_s).join(' ')}"
          end
        end
      end
    end
  end
end
