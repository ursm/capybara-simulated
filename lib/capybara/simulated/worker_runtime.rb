# frozen_string_literal: true

module Capybara
  module Simulated
    # Engine-uniform adapter Browser#run_worker drives. Each engine
    # class (`V8Runtime`, `QuickJSRuntime`) has a `build_worker` class
    # method that constructs the engine-specific Context/VM and wires
    # it through these five callbacks. Worker thread doesn't care
    # which engine it's running on; it just calls `eval_void` / `call` /
    # `drain_microtasks` / `drain_timers` / `has_ready_timer?` /
    # `dispose`.
    class WorkerRuntime
      def initialize(eval_void_fn:, call_fn:, drain_microtasks:, drain_timers:, has_ready_timer:, dispose:, eval_module_graph: nil)
        @eval_void         = eval_void_fn
        @call              = call_fn
        @drain_microtasks  = drain_microtasks
        @drain_timers      = drain_timers
        @has_ready_timer   = has_ready_timer
        @dispose           = dispose
        @eval_module_graph = eval_module_graph
      end

      def eval_void(src)             = @eval_void.call(src)
      def call(name, *args)          = @call.call(name, *args)
      def drain_microtasks           = @drain_microtasks.call
      def drain_timers               = @drain_timers.call
      def has_ready_timer?           = @has_ready_timer.call
      def dispose                    = @dispose.call

      # Native ES-module evaluation of a worker MAIN script + its static import
      # graph (a `{type: 'module'}` service worker). `fetch_import` is called on
      # the worker's own thread for each resolved static import URL and returns
      # the script source (raising fails the evaluation — an import that 404s or
      # has a non-JS MIME type fails the module script, and with it the Run
      # Service Worker job). nil on engines without a native module API
      # (QuickJS) — the caller falls back to the classic-eval path.
      def module_graph?                             = !@eval_module_graph.nil?
      def eval_module_graph(src, url, fetch_import) = @eval_module_graph.call(src, url, fetch_import)
    end
  end
end
