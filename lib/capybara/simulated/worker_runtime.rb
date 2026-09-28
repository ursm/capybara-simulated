# frozen_string_literal: true

module Capybara
  module Simulated
    # The worker isolate Browser#run_worker drives. `V8Runtime.build_worker`
    # builds the worker's own Context — host fns attached, worker scope
    # installed — and hands it here, so the worker thread only ever calls
    # `eval_void` / `call` / `drain_microtasks` / `drain_timers` /
    # `has_ready_timer?` / `terminate` / `dispose` / `eval_module_graph`.
    class WorkerRuntime
      def initialize(ctx)
        @ctx = ctx
      end

      def eval_void(src)    = @ctx.eval_void(src.to_s)
      def call(name, *args) = @ctx.call(name.to_s, *args)
      def drain_microtasks  = @ctx.perform_microtask_checkpoint
      def drain_timers      = @ctx.call('__drainTimers', 50)
      def has_ready_timer?  = !!@ctx.call('__hasReadyTimer')
      def dispose           = (@ctx.dispose rescue nil)

      # Stop whatever JavaScript this worker is running, FROM ANOTHER THREAD — the one thing the
      # main thread can do to a worker that is inside a call, where the `:terminate` inbox message
      # cannot reach it and `Thread#kill` does not land (see `Browser#stop_worker_js`). Called from
      # the SESSION BOUNDARY's thread, not this worker's: V8's terminate is thread-safe by design,
      # and it is the only way to end a call that is already running. The call in flight ends as a
      # terminated call; the worker's own loop then unwinds and disposes.
      def terminate = (@ctx.terminate rescue nil)

      # Native ES-module evaluation of a worker MAIN script + its static import
      # graph (a `{type: 'module'}` service worker), via V8's native module API
      # (the same surface the main realm's eval_esm_module uses). The whole graph
      # resolves through the root's instantiate callback (V8 calls it per
      # unresolved edge, transitively). `fetch_import` is called on the worker's
      # own thread for each resolved static import URL and returns the script
      # source (raising fails the evaluation — an import that 404s or has a
      # non-JS MIME type fails the module script, and with it the Run Service
      # Worker job). Specifier resolution is PLAIN URL resolution — a worker has
      # no document, so the page's importmap does not apply, and a bare
      # specifier is a resolution failure per the spec.
      def eval_module_graph(src, url, fetch_import)
        handles = {}
        root    = @ctx.compile_module(RuntimeShared.utf8_text(src.to_s.dup), filename: url.to_s)
        handles[url.to_s] = root
        root.instantiate do |spec, ref|
          s = spec.to_s
          resolved =
            if s.match?(%r{\A[a-z]+://}i)
              s
            elsif s.start_with?('/', './', '../')
              URI.join((ref || url).to_s, s).to_s
            else
              raise "Failed to resolve module specifier '#{s}'"
            end
          handles[resolved] ||= @ctx.compile_module(RuntimeShared.utf8_text(fetch_import.call(resolved).to_s.dup), filename: resolved)
        end
        # Top-level await is disallowed in a service worker module ("Run Service
        # Worker" fails the script; Chrome rejects the registration). V8's
        # IsGraphAsync (Module#graph_async?) answers it for the WHOLE
        # instantiated graph, which is what the spec asks: TLA hiding in an
        # imported module fails too. Per-module `[[HasTLA]]` would name the
        # offender but not this question — it can't see an imported module's
        # await. This serves service workers only; a dedicated module worker,
        # where TLA is legal, would need the check parameterized.
        raise 'Top-level await is disallowed in a service worker' if root.graph_async?

        root.evaluate
        nil
      end
    end
  end
end
