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

      def eval_void(src, **kw) = @ctx.eval_void(src.to_s, **kw)
      def call(step, *args) = @ctx.step(step.to_s).call(*args)
      # (…the bridge's checkpoint, with the steps HTML runs after it: V8Runtime#drain_microtasks)
      def drain_microtasks  = call('yield')
      # (…its clock advanced `ms` — a poll tick's, or as far as the window's clock went meanwhile: Browser#run_worker)
      def drain_timers(ms = 50) = call('drainTimers', ms.to_i)
      def has_ready_timer?  = !!call('hasReadyTimer')
      def dispose           = (@ctx.dispose rescue nil)

      # Stop whatever JavaScript this worker is running, FROM ANOTHER THREAD — the one thing the
      # main thread can do to a worker that is inside a call, where the `:terminate` inbox message
      # cannot reach it and `Thread#kill` does not land (see `Browser#stop_worker_js`). Called from
      # the SESSION BOUNDARY's thread, not this worker's: V8's terminate is thread-safe by design,
      # and it is the only way to end a call that is already running. The call in flight ends as a
      # terminated call; the worker's own loop then unwinds and disposes.
      def terminate = (@ctx.terminate rescue nil)

      # A module service worker's script run as a module graph: the engine's module map fetches it (module_map.rs — the
      # worker's map: the empty import map, a `type` its import names the module type, CSS none in a worker), its script
      # `src` of `url` already in hand, its imports through `fetch_import` (`module_steps`), fetched whole as the worker
      # waits — none of its servers' time on its clock: its job waits on its evaluation — and the graph linked and
      # evaluated here. One that could not be fetched, or that has an error to rethrow, raises `ModuleGraphFailed`.
      #
      # A SERVICE worker's graph, fetched whole as it waits — its job waits on its evaluation — may not await at its top
      # level ("Run Service Worker" fails the script; Chrome rejects the registration): V8's IsGraphAsync
      # (Module#graph_async?) answers it for the WHOLE instantiated graph, TLA hiding in an imported module included — and
      # what its evaluation throws fails the job its caller runs. Any other worker's may, and what its evaluation throws —
      # now, or as an awaited module settles — is reported in the worker's global as a classic script's exception is (HTML
      # "run a module script").
      def eval_module_graph(src, url, fetch_import)
        module_steps(fetch_import, url.to_s => [src, url.to_s, 'text/javascript'])
        root = linked_graph(call('moduleWorkerGraph', url.to_s), url)
        raise 'Top-level await is disallowed in a service worker' if root.graph_async?

        root.evaluate
        nil
      end
      # …a dedicated or a shared worker's, begun: its graph fetched as the service worker's is, each module landing as far
      # after its fetch began as its server took — the worker's timers waiting it out, on the clock it follows, its
      # window's (workers.js `beginModuleWorker`) — and run once every module is in, the messages its owner posted
      # meanwhile delivered after (HTML "run a worker": its port message queue enabled once its script has run). What
      # fails it — none of its modules to be had, its error to rethrow, its link's — goes to `failed`.
      def begin_module_graph(src, url, fetch_import, failed)
        module_steps(fetch_import, url.to_s => [src, url.to_s, 'text/javascript'])
        @ctx.attach('@moduleWorkerRun', lambda do |result|
          linked_graph(result, url).evaluate(report: '@steps.reportError')
          nil
        rescue ModuleGraphFailed, RustyRacer::ParseError, RustyRacer::RuntimeError => e
          failed.call("#{e.class}: #{e.message}")
          nil
        end)
        call('beginModuleWorker', url.to_s)
        nil
      end
      # …what the map handed over (`moduleGraphResult`), its root linked — its `import()`s' fetches the script's from
      # here, its graph's of the worker's destination over (HostLoadImportedModule with no load state: `script`).
      private def linked_graph(result, url)
        module_steps(@dynamic_fetch) if @dynamic_fetch
        raise ModuleGraphFailed, "module script failed: #{url}" unless result.is_a?(Array)
        raise ModuleGraphFailed, result[0].first(2).join(': ') if result[0].is_a?(Array)

        RuntimeShared.linked_module(@modules, result) or raise ModuleGraphFailed, "module script failed: #{url}"
      end
      # …what a module graph of the worker's could not come to: a module none could fetch, or its error to rethrow.
      class ModuleGraphFailed < StandardError; end

      # A dedicated or shared worker's `import()`, from a classic script or a module: its graph the map's
      # (bridge.entry.js `moduleImport`), its modules fetched by `fetch_import`, whose evaluation the engine finishes before
      # it settles the import's promise.
      # (…the import's rejection the engine's Error, of no kind — rusty_racer)
      def accept_dynamic_imports(fetch_import)
        module_steps(@dynamic_fetch = fetch_import)
        @ctx.dynamic_import_resolver = lambda do |specifier, referrer, _initiating|
          result = call('moduleImport', specifier.to_s, referrer.to_s)
          raise ModuleGraphFailed, "module not found: #{specifier}" unless result.is_a?(Array)
          raise ModuleGraphFailed, result[0][1].to_s if result[0].is_a?(Array)

          RuntimeShared.linked_module(@modules, result) or raise ModuleGraphFailed, "module not found: #{specifier}"
        end
      end

      private

      # The host steps of the worker's module map (subresource-host.js `H_MODULE_START` / `H_MODULE_TAKE`): a module's
      # fetch made at once by `fetch_import` (`[source, response URL, content type, its server's ms]`; raising for none) — `seeded` the
      # ones already in hand — and what came in compiled into a record of the worker's (`@modules`), held to its module
      # type's MIME type: `[record, body, base URL]`, its parse error `[name, message, filename, lineno]`, nil for none.
      def module_steps(fetch_import, seeded = {})
        @modules ||= {records: {}, links: {}}
        @module_seq ||= 0
        @fetched ||= {}
        @ctx.attach('@moduleFetchStart', ->(url, *rest) {
          id = rest[7].to_i
          @fetched[id] = seeded.delete(url.to_s) || begin
            fetch_import.call(url.to_s, rest[5].to_i & 0xff)
          rescue StandardError
            nil
          end
          # (…how long its server took: `fetch_import`'s fourth, the sleeps it counted — what the module lands after)
          @fetched[id] && @fetched[id][3].to_f
        })
        @ctx.attach('@moduleFetchTake', ->(id, type, _now) {
          source, base, content_type = @fetched.delete(id.to_i)
          next nil unless source && Native.module_content(content_type.to_s, type.to_i)

          module_record(source, base, type.to_i)
        })
      end
      def module_record(source, base, type)
        body = Native.module_body(RuntimeShared.utf8_text(source.to_s.dup), type) or return ['SyntaxError', 'JSON module is not valid JSON', base, nil]
        m = @ctx.compile_module(body, filename: base.to_s)
        id = (@module_seq += 1)
        @modules[:records][id] = m
        [id, type.zero? ? body : nil, base.to_s]
      rescue RustyRacer::ParseError => e
        RuntimeShared.module_error(e.message, base)
      end
    end
  end
end
