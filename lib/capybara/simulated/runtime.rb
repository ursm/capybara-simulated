# frozen_string_literal: true

# mini_racer Context wrapper. The DOM lives in JS; this class owns the
# V8 context, the warm snapshot, the host-fn callbacks the bridge reaches
# back through, and the per-visit `rebuild_ctx` dance.

require 'mini_racer'
require 'base64'
require 'json'
require 'securerandom'
require 'set'

require_relative 'url_shape'


begin
  stack_kb = (ENV['CSIM_V8_STACK_KB'] || '2000').to_i
  if ENV['CSIM_V8_SINGLE_THREADED'] == '1'
    MiniRacer::Platform.set_flags!(:single_threaded, stack_size: stack_kb)
  else
    MiniRacer::Platform.set_flags!(stack_size: stack_kb)
  end
  # `CSIM_V8_PROF=1` turns on V8's tick-sampling profiler. Output
  # lands in `isolate-*-v8.log`; process with:
  #   node --prof-process isolate-*-v8.log > prof.txt
  # (Standard Node distribution ships the post-processor; no extra
  # install needed.) The log is per-isolate, so per-visit
  # `rebuild_ctx` produces one file per Context.
  if ENV['CSIM_V8_PROF'] == '1'
    MiniRacer::Platform.set_flags!(:prof, 'logfile-per-isolate': nil)
  end
rescue MiniRacer::PlatformAlreadyInitialized
end

module Capybara
  module Simulated
    class Runtime
      BRIDGE_JS  = File.expand_path('../../../vendor/js/bridge.js',  __dir__).freeze
      WGXPATH_JS = File.expand_path('../../../vendor/js/wgxpath.js', __dir__).freeze

      # Stub host fns so the bridge can be baked into a Snapshot. Only
      # the host fns bridge.js actually invokes appear here.
      SNAPSHOT_HOST_STUBS = <<~JS.freeze
        Object.defineProperty(globalThis, Symbol.toStringTag, { value: 'Window' });
        globalThis.__csim_parseUrl = function (input, base) {
          return {
            href: 'http://placeholder/', protocol: 'http:',
            username: '', password: '', host: 'placeholder',
            hostname: 'placeholder', port: '', pathname: '/',
            search: '', hash: '', origin: 'http://placeholder'
          };
        };
        globalThis.__csim_randomUUID  = function () { return '00000000-0000-0000-0000-000000000000'; };
        globalThis.__csim_randomBytes = function (n) { return new Array(n).fill(0); };
        globalThis.__csim_atob        = function (s) { return ''; };
        globalThis.__csim_btoa        = function (s) { return ''; };
        globalThis.__csim_utf8Encode  = function (s) { return []; };
        globalThis.__csim_utf8Decode  = function (a) { return ''; };
        globalThis.__rackFetch              = function () { return null; };
        globalThis.__locationAssign         = function () { return null; };
        globalThis.__locationReload         = function () { return null; };
        globalThis.__setTimersActive        = function () { return null; };
        globalThis.__setCurrentUrl          = function () { return null; };
        globalThis.__pushHistoryEntry       = function () { return null; };
        globalThis.__csimReadFilePick       = function () { return null; };
        globalThis.__getDocumentCookie      = function () { return ''; };
        globalThis.__setDocumentCookie      = function () { return null; };
        globalThis.__csim_storageGet        = function () { return null; };
        globalThis.__csim_storageSet        = function () { return null; };
        globalThis.__csim_storageRemove     = function () { return null; };
        globalThis.__csim_storageClear      = function () { return null; };
        globalThis.__csim_storageKey        = function () { return null; };
        globalThis.__csim_storageLength     = function () { return 0; };
        globalThis.__modalDialog            = function () { return null; };
        // ESM loader callback — overridden by Ruby host fn at boot.
        // Has to exist on the snapshot so `__csim_require` can
        // reference it inside the bridge's IIFE.
        globalThis.__csim_fetchModuleSource = function () { return null; };
        globalThis.__csim_pushImportmap     = function () { return null; };
        globalThis.__csim_logConsole        = function () { return null; };
      JS

      @@snapshot_lock = Mutex.new
      @@snapshot      = nil
      @@live_lock     = Mutex.new
      @@live          = []

      at_exit do
        @@live_lock.synchronize {
          @@live.each {|c|
            begin
              c.stop rescue nil
              c.dispose
            rescue StandardError
            end
          }
          @@live.clear
        }
      end

      def self.snapshot
        @@snapshot_lock.synchronize { @@snapshot ||= build_snapshot }
      end

      # Pre-warm script: exercises the JS surfaces that get JIT-compiled
      # on every page load (HTML parse, selector tokenise + match, event
      # dispatch, style-decl parse, cascade resolve). Runs once at
      # snapshot creation; the resulting bytecode-cache state ships in
      # the snapshot so each new Context starts with these paths warm.
      SNAPSHOT_WARMUP = <<~JS.freeze
        (function () {
          // Drive a representative document through parse → script
          // eval → selector / event / cascade primitives so the
          // bytecode cache covers them when a real visit hits.
          const html = '<!doctype html><html><head><style>' +
            '.a { display: none } .a.show { display: block }' +
            '#m, .b > .c { visibility: hidden }' +
            '@media (max-width: 899px) { .b { display: none } }' +
            '</style></head><body>' +
            '<div id="m" class="a"><span class="b"><a class="c" href="/x">x</a></span></div>' +
            '<form><input name="q" type="text" value="hi"><button type="submit">go</button></form>' +
            '<script>document.querySelector("#m");</script>' +
            '</body></html>';
          try { __csimLoadDocument(html); } catch (_) {}
          try { __csimEvaluateXPath('//a', 0); } catch (_) {}
          try { __csimVisible(1); } catch (_) {}
          try { __csimQuery(0, '#m'); } catch (_) {}
          try { __csimQuery(0, '.b > .c'); } catch (_) {}
          try {
            const root = document.documentElement;
            if (root) {
              root.querySelectorAll('a');
              root.querySelectorAll('.b > .c, #m');
            }
          } catch (_) {}
        })();
      JS

      def self.build_snapshot
        # Order matters: bridge.js installs `globalThis.Document` (etc.)
        # first, then wgxpath patches `Document.prototype.evaluate` on
        # top, then the install-on-current-document line ties it to the
        # live `document` instance the bridge created.
        src = SNAPSHOT_HOST_STUBS +
              File.read(BRIDGE_JS) +
              File.read(WGXPATH_JS) + ";\n" +
              "wgxpath.install(globalThis);\n"
        snap = MiniRacer::Snapshot.new(src)
        # `warmup!` runs `SNAPSHOT_WARMUP` against the snapshot once
        # and rolls the resulting V8 bytecode-cache state back in, so
        # Contexts created from this snapshot inherit JIT-primed
        # versions of the hot paths above. Without warmup, every per-
        # visit Context rebuild paid first-time compilation again.
        snap.warmup!(SNAPSHOT_WARMUP) rescue nil
        snap
      end

      # Maintain a small pool of warmed-up Contexts per Browser. Each
      # entry is post-snapshot, post-attach_host_fns — checkout is just
      # `pool.pop`. Background thread refills after each checkout so
      # the pool stays full while tests run sequentially. Pool size 1
      # would be enough for strictly serial visits, but 2 absorbs the
      # case where `refill` is still building when the next visit
      # arrives (form submit → redirect → another navigate, back-to-back).
      POOL_SIZE = 2

      def initialize(browser)
        @browser     = browser
        @ctx         = nil
        @pool        = Queue.new
        @pool_lock   = Mutex.new
        @refill_busy = false
        # Every Context is built from the base snapshot (bridge +
        # wgxpath). Library scripts (`<script src>`) get evaluated
        # per-visit just like a real browser does on page navigation.
        # Pre-evaluating libraries into the snapshot heap is not safe:
        # jQuery's `readyList` Callbacks queue would carry `$(handler)`
        # registrations from a prior page's scripts, and a single
        # throwing handler (e.g. touching a DOM node that only existed
        # on the prior page) aborts iteration mid-fire and silently
        # drops every later callback — including the current page's.
        @snapshot = self.class.snapshot
        refill_pool_async
      end

      def eval(code)         = ctx.eval(code.to_s)
      def call(name, *args)  = ctx.call(name, *args)

      # bridge.js owns the virtual clock; Ruby still drives it because
      # Capybara's polling cadence is wall-clock-anchored. Use `call`
      # (function reference) rather than `eval` (string compile) — the
      # polling loop hits these every retry tick.
      def drain_timers(max_ms = nil)
        max_ms.nil? ? ctx.call('__drainTimers') : ctx.call('__drainTimers', max_ms.to_i)
      end

      # mini_racer drains microtasks at every `eval` boundary, so an
      # empty `eval('0')` is the cheapest way to advance one round of
      # chained `await`/`.then` queues. `settle` calls this in a loop
      # to give the JS side a chance to drain before we tick real time.
      def drain_microtasks(iters = 4)
        i = iters.to_i
        return if i <= 0
        c = ctx
        i.times { c.eval('0') }
      end

      def settle_gen
        ctx.call('__settleGenGet').to_i
      end

      def has_ready_timer?
        return false if @ctx.nil?
        !!ctx.call('__hasReadyTimer')
      end

      def reset_timers
        return if @ctx.nil?
        ctx.call('__resetTimers')
      end

      # Tears down the current Context and brings up a fresh one from
      # the warm snapshot. Partial in-Context resets are not safe (see
      # feedback_visit_always_rebuilds memory): library init guards
      # stick, delegate registrations leak between visits. The snapshot
      # warmup keeps the per-rebuild cost ~3 ms; jQuery / app-bundle
      # re-eval dominates after that.
      def rebuild_ctx
        old = @ctx
        @ctx = nil
        # Hand the old Context off to a disposal thread so the next
        # visit doesn't wait on V8 teardown. Dispose order doesn't
        # matter — handles + listeners die with the Context.
        if old
          @@live_lock.synchronize { @@live.delete(old) }
          Thread.new { begin
            old.stop rescue nil
            old.dispose
          rescue StandardError
          end }
        end
        @ctx = checkout_ctx
        refill_pool_async
        @ctx
      end

      # Capybara calls `Driver#reset!` between tests; Browser delegates
      # here. With per-visit rebuild already running, the inter-test
      # path is the same operation.
      def reset_page = rebuild_ctx

      def ctx
        @ctx ||= begin
          c = checkout_ctx
          refill_pool_async
          c
        end
      end

      # Pulls a warm Context from the pool; if the pool is empty
      # (first call, or refill thread hasn't caught up) builds one
      # synchronously and registers it in `@@live` so at_exit cleanup
      # still sees it. Pool entries are pre-registered in `@@live` at
      # refill time, so the pool path doesn't double-register.
      def checkout_ctx
        @pool.pop(true)
      rescue ThreadError
        c = build_ctx
        @@live_lock.synchronize { @@live << c }
        c
      end

      def build_ctx
        c = MiniRacer::Context.new(snapshot: @snapshot || self.class.snapshot)
        attach_host_fns(c)
        c
      end

      def refill_pool_async
        @pool_lock.synchronize {
          return if @refill_busy
          return if @pool.size >= POOL_SIZE
          @refill_busy = true
        }
        Thread.new do
          begin
            until @pool.size >= POOL_SIZE
              c = build_ctx
              # Track pool entries so at_exit disposes them too —
              # pool members aren't currently checked out so they
              # wouldn't otherwise reach the cleanup path.
              @@live_lock.synchronize { @@live << c }
              @pool.push(c)
            end
          ensure
            @pool_lock.synchronize { @refill_busy = false }
          end
        end
      end

      def safe_call
        yield
      rescue StandardError => e
        warn "[capybara-simulated] host fn error: #{e.class}: #{e.message[0, 200]}"
        nil
      end

      def attach_host_fns(c)
        browser = @browser
        sc      = method(:safe_call)
        c.attach('__rackFetch',                     ->(*a) { sc.() { browser.rack_fetch(a[0], a[1], a[2], a[3], a[4]) } })
        c.attach('__locationAssign',                ->(*a) { sc.() { browser.location_assign(a[0]); nil } })
        c.attach('__locationReload',                ->(*a) { sc.() { browser.location_reload; nil } })
        c.attach('__setTimersActive',               ->(*a) { sc.() { browser.timers_active = !!a[0]; nil } })
        c.attach('__setCurrentUrl',                 ->(*a) { sc.() { browser.history_state(a[0]); nil } })
        c.attach('__pushHistoryEntry',              ->(*a) { sc.() { browser.history_push(a[0]); nil } })
        c.attach('__csimReadFilePick',              ->(*a) { sc.() { browser.read_file_pick(a[0], a[1], a[2], a[3]) } })
        c.attach('__getDocumentCookie',             ->(*a) { sc.() { browser.document_cookie } })
        c.attach('__setDocumentCookie',             ->(*a) { sc.() { browser.write_document_cookie(a[0].to_s); nil } })
        c.attach('__csim_storageGet',               ->(*a) { sc.() { browser.storage_get(a[0], a[1]) } })
        c.attach('__csim_storageSet',               ->(*a) { sc.() { browser.storage_set(a[0], a[1], a[2]); nil } })
        c.attach('__csim_storageRemove',            ->(*a) { sc.() { browser.storage_remove(a[0], a[1]); nil } })
        c.attach('__csim_storageClear',             ->(*a) { sc.() { browser.storage_clear(a[0]); nil } })
        c.attach('__csim_storageKey',               ->(*a) { sc.() { browser.storage_key(a[0], a[1]) } })
        c.attach('__csim_storageLength',            ->(*a) { sc.() { browser.storage_length(a[0]) } })
        c.attach('__modalDialog',                   ->(*a) { sc.() { browser.handle_modal(a[0], a[1], a[2]) } })
        c.attach('__csim_randomUUID',  ->(*a) { SecureRandom.uuid })
        c.attach('__csim_randomBytes', ->(*a) { SecureRandom.bytes(a[0].to_i).bytes })
        c.attach('__csim_atob',        ->(*a) { Base64.decode64(a[0].to_s) })
        c.attach('__csim_btoa',        ->(*a) { Base64.strict_encode64(a[0].to_s) })
        c.attach('__csim_utf8Encode',  ->(*a) { a[0].to_s.b.bytes })
        c.attach('__csim_utf8Decode',  ->(*a) { a[0].pack('C*').force_encoding('UTF-8') })
        c.attach('__csim_parseUrl',    ->(*a) { UrlShape.parse_for_js(a[0], a[1]) })
        c.attach('__csim_fetchModuleSource', ->(*a) { sc.() { fetch_module_source(browser, a[0]) } })
        c.attach('__csim_pushImportmap',     ->(*a) { sc.() { browser.set_importmap(a[0]); nil } })
        c.attach('__csim_logConsole',        ->(*a) { sc.() { browser.log_console(a[0], a[1]); nil } })
      end

      # Bridges Ruby-side `Browser#load_module` (Rack fetch +
      # rewrite_module_imports + EsmRewriter) into the JS-side loader's
      # `__csim_fetchModuleSource(url)` hook. Caching lives on Browser
      # so it survives Context rebuilds.
      def fetch_module_source(browser, url) = browser.load_module(url)
    end
  end
end
