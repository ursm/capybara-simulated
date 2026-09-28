# frozen_string_literal: true

module Capybara
  module Simulated
    # The adapter Browser#run_worker drives. `V8Runtime.build_worker`
    # constructs the worker's own Context and wires it through these
    # callbacks, so the worker thread only ever calls `eval_void` /
    # `call` / `drain_microtasks` / `drain_timers` / `has_ready_timer?` /
    # `terminate` / `dispose` / `eval_module_graph`.
    class WorkerRuntime
      def initialize(eval_void_fn:, call_fn:, drain_microtasks:, drain_timers:, has_ready_timer:, dispose:, terminate:, eval_module_graph:)
        @eval_void         = eval_void_fn
        @call              = call_fn
        @drain_microtasks  = drain_microtasks
        @drain_timers      = drain_timers
        @has_ready_timer   = has_ready_timer
        @dispose           = dispose
        @terminate         = terminate
        @eval_module_graph = eval_module_graph
      end

      def eval_void(src)             = @eval_void.call(src)
      def call(name, *args)          = @call.call(name, *args)
      def drain_microtasks           = @drain_microtasks.call
      def drain_timers               = @drain_timers.call
      def has_ready_timer?           = @has_ready_timer.call
      def dispose                    = @dispose.call
      # Stop whatever JavaScript this worker is running, FROM ANOTHER THREAD — the one thing the
      # main thread can do to a worker that is inside a call, where the `:terminate` inbox message
      # cannot reach it and `Thread#kill` does not land (see `Browser#stop_worker_js`). The call in
      # flight ends as a terminated call; the worker's own loop then unwinds and disposes.
      def terminate                  = @terminate.call

      # Native ES-module evaluation of a worker MAIN script + its static import
      # graph (a `{type: 'module'}` service worker). `fetch_import` is called on
      # the worker's own thread for each resolved static import URL and returns
      # the script source (raising fails the evaluation — an import that 404s or
      # has a non-JS MIME type fails the module script, and with it the Run
      # Service Worker job).
      def eval_module_graph(src, url, fetch_import) = @eval_module_graph.call(src, url, fetch_import)
    end
  end
end
