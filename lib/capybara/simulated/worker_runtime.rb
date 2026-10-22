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
      # (…the bridge's checkpoint, with the steps HTML runs after it: V8Runtime#drain_microtasks)
      def drain_microtasks  = @ctx.call('__csim_yield')
      # (…its clock advanced `ms` — a poll tick's, or as far as the window's clock went meanwhile: Browser#run_worker)
      def drain_timers(ms = 50) = @ctx.call('__drainTimers', ms.to_i)
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
      # graph (a `{type: 'module'}` worker), via V8's native module API
      # (the same surface the main realm's eval_esm_module uses). The whole graph
      # resolves through the root's instantiate callback (V8 calls it per
      # unresolved edge, transitively). `fetch_import` is called on the worker's
      # own thread for each resolved static import URL and returns the script
      # source (raising fails the evaluation — an import that 404s or has a
      # non-JS MIME type fails the module script). Specifier resolution is PLAIN
      # URL resolution — a worker has no document, so the page's importmap does
      # not apply, and a bare specifier is a resolution failure per the spec.
      #
      # A SERVICE worker's graph may not await at its top level ("Run Service
      # Worker" fails the script; Chrome rejects the registration) — V8's
      # IsGraphAsync (Module#graph_async?) answers it for the WHOLE instantiated
      # graph, TLA hiding in an imported module included — and what its
      # evaluation throws fails the job its caller runs. Any other worker's may,
      # and what its evaluation throws — now, or as an awaited module settles — is
      # reported in the worker's global as a classic script's exception is (HTML
      # "run a module script").
      def eval_module_graph(src, url, fetch_import, service: true)
        @fetch_import = fetch_import
        root = @ctx.compile_module(RuntimeShared.utf8_text(src.to_s.dup), filename: url.to_s)
        (@modules ||= {})[url.to_s] = root
        link(root, url.to_s)
        if service
          raise 'Top-level await is disallowed in a service worker' if root.graph_async?

          root.evaluate
        else
          root.evaluate(report: '__csimReportError')
        end
        nil
      end

      # A dedicated or shared worker's `import()`, from a classic script (of `url`) or a module: the module its specifier
      # names, fetched by `fetch_import` and linked as a static import's is — each one module however often it is
      # imported — whose evaluation the engine finishes before it settles the import's promise.
      def accept_dynamic_imports(url, fetch_import)
        @fetch_import = fetch_import
        @ctx.dynamic_import_resolver = lambda do |specifier, referrer, _initiating|
          # (…a classic script's referrer no URL — none, or the name it was evaluated under: `<eval>` — the worker's own its
          # base, the URL its script was run from)
          ref  = referrer.to_s
          base = ref.match?(/\A[a-z][a-z0-9+.-]*:/i) ? ref : url
          resolved = resolve_specifier(specifier.to_s, base)
          module_for(resolved).tap {|m| link(m, resolved) if m.status == :uninstantiated }
        end
      end

      private

      def link(root, url)
        root.instantiate do |spec, ref|
          module_for(resolve_specifier(spec.to_s, (ref || url).to_s))
        end
      end
      # (…the module `resolved` names, one however often it is imported: its source and its URL — the response's, a
      # redirect's end, which a fetch answering a pair gives and the module's own imports resolve against — fetched once)
      def module_for(resolved)
        @modules ||= {}
        @modules[resolved] ||= begin
          src, final = @fetch_import.call(resolved)
          final = final.to_s.empty? ? resolved : final.to_s
          @modules[final] ||= @ctx.compile_module(RuntimeShared.utf8_text(src.to_s.dup), filename: final)
        end
      end
      # (…a URL, or a path-relative specifier parsed against the importing module's URL — none where that is no base, a
      # blob: or data: one's — any other a resolution failure)
      def resolve_specifier(spec, base)
        resolved =
          if spec.match?(%r{\A[a-z][a-z0-9+.-]*:}i) then spec
          elsif spec.start_with?('/', './', '../') then Native.url_parts(spec, base)&.first
          end
        resolved or raise "Failed to resolve module specifier '#{spec}'"
      end
    end
  end
end
