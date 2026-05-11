# frozen_string_literal: true

# `CSIM_JS_ENGINE=none` (or auto-selected when neither `quickjs` nor
# `mini_racer` is loadable). The runtime that doesn't run any JS.
#
# What still works: HTML parsing, link follow, form submit, cookies,
# matchers against the served HTML. Effectively rack-test, but with
# Nokogiri parsing and our usual DOM lookup semantics.
#
# What doesn't: `<script>` tags are ignored; `evaluate_script` returns
# `nil`; no event handlers fire; Stimulus / Turbo / React all silent.
# This mode is useful for fast scans of JS-independent flows and for
# isolating bugs ("does it reproduce without JS?").

module Capybara
  module Simulated
    class NoJsRuntime
      def initialize(_browser, extra_features: []); end

      def eval(_code)        = nil
      def call(*)            = nil
      def drain_timers(_=nil); end
      def has_ready_timer? = false
      def reset_timers; end
      def reset_page; end
      def run_scripts(_browser, _document); end
      def run_classic_script(_browser, _script); end
      def run_module_script(_browser, _script); end
      def eval_module_entry(_url); end
      def eval_safely(_code, _label); end
    end
  end
end
