# frozen_string_literal: true

module Capybara
  module Simulated
    # Engine-uniform adapter Browser#run_worker drives. Each engine
    # class (`V8Runtime`, `QuickJSRuntime`) has a `build_worker` class
    # method that constructs the engine-specific Context/VM and wires
    # it through these five callbacks. Worker thread doesn't care
    # which engine it's running on; it just calls `eval` / `call` /
    # `drain_microtasks` / `drain_timers` / `has_ready_timer?` /
    # `dispose`.
    class WorkerRuntime
      def initialize(eval_fn:, call_fn:, drain_microtasks:, drain_timers:, has_ready_timer:, dispose:)
        @eval             = eval_fn
        @call             = call_fn
        @drain_microtasks = drain_microtasks
        @drain_timers     = drain_timers
        @has_ready_timer  = has_ready_timer
        @dispose          = dispose
      end

      def eval(src)                  = @eval.call(src)
      def call(name, *args)          = @call.call(name, *args)
      def drain_microtasks           = @drain_microtasks.call
      def drain_timers               = @drain_timers.call
      def has_ready_timer?           = @has_ready_timer.call
      def dispose                    = @dispose.call
    end
  end
end
