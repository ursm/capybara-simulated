# frozen_string_literal: true

# v3 runtime: mini_racer Context wrapper for the all-in-V8 architecture
# (DOM lives in JS, no Nokogiri tree). Surface mirrors `V8Runtime` so
# the rest of the gem doesn't need to know which v we're on.

require 'mini_racer'
require 'base64'
require 'digest'
require 'fileutils'
require 'json'
require 'securerandom'
require 'set'

require_relative 'esm_rewriter'

begin
  stack_kb = (ENV['CSIM_V8_STACK_KB'] || '2000').to_i
  if ENV['CSIM_V8_SINGLE_THREADED'] == '1'
    MiniRacer::Platform.set_flags!(:single_threaded, stack_size: stack_kb)
  else
    MiniRacer::Platform.set_flags!(stack_size: stack_kb)
  end
rescue MiniRacer::PlatformAlreadyInitialized
end

module Capybara
  module Simulated
    class V3Runtime
      BRIDGE_JS  = File.expand_path('../../../vendor/js/v3_bridge.js', __dir__).freeze
      WGXPATH_JS = File.expand_path('../../../vendor/js/wgxpath.js',   __dir__).freeze

      # Stub host fns so the bridge can be baked into a Snapshot. Same
      # shape as `V8Runtime::SNAPSHOT_HOST_STUBS`; only the host fns
      # v3_bridge.js actually invokes appear here.
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
        globalThis.__setListenedType        = function () { return null; };
        globalThis.__setTimersActive        = function () { return null; };
        globalThis.__setIntersectionObserverActive = function () { return null; };
        globalThis.__setCurrentUrl          = function () { return null; };
        globalThis.__getDocumentCookie      = function () { return ''; };
        globalThis.__setDocumentCookie      = function () { return null; };
        globalThis.__modalDialog            = function () { return null; };
        // ESM loader callback — overridden by Ruby host fn at boot.
        // Has to exist on the snapshot so `__csim_require` can
        // reference it inside the bridge's IIFE.
        globalThis.__csim_fetchModuleSource = function () { return null; };
        globalThis.__csim_pushImportmap     = function () { return null; };
      JS

      @@snapshot_lock = Mutex.new
      @@snapshot      = nil
      @@live_lock     = Mutex.new
      @@live          = []
      # Class-level app-warm snapshot cache: many Browsers in the same
      # RubyVM that share an app boot to the same library set, so we
      # only need to build / load one snapshot per content hash.
      @@app_snap_lock  = Mutex.new
      @@app_snap_cache = {}

      # `tmp/csim/` keeps `snapshot-<hash>.bin` files between test runs.
      # Honors `CSIM_CACHE_DIR` for environments where the gem isn't
      # running out of the project's tmp dir.
      def self.cache_dir
        ENV['CSIM_CACHE_DIR'] || File.join(Dir.pwd, 'tmp', 'csim')
      end

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
        # Order matters: v3_bridge installs `globalThis.Document` (etc.)
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
        # Each Browser starts on the base snapshot (bridge + wgxpath
        # only). After the first visit completes, `install_app_snapshot`
        # promotes us to an app-warm snapshot built from the library
        # scripts the page loaded. From that point on the pool refills
        # from the app snapshot so subsequent visits skip library
        # re-evaluation.
        @snapshot = self.class.snapshot
        @app_snapshot_installed = false
        refill_pool_async
      end

      def eval(code)         = ctx.eval(code.to_s)
      def call(name, *args)  = ctx.call(name, *args)

      # bridge.js owns the virtual clock; Ruby still drives it because
      # Capybara's polling cadence is wall-clock-anchored.
      def drain_timers(max_ms = nil)
        arg = max_ms.nil? ? '' : max_ms.to_i.to_s
        ctx.eval("__drainTimers(#{arg})")
      end

      def has_ready_timer?
        return false if @ctx.nil?
        ctx.eval('!!__hasReadyTimer()')
      end

      def reset_timers
        return if @ctx.nil?
        ctx.eval('__resetTimers()')
      end

      # Tears down the current Context and brings up a fresh one from
      # the warm snapshot. Mirrors v2's "checkout fresh VM per visit"
      # model: per CLAUDE.md / feedback_visit_always_rebuilds memory,
      # partial in-Context state resets (the previous `__resetPage`
      # approach) drift out of sync — library init guards stick,
      # delegate registrations leak between visits. Rebuilding the
      # Context is predictable and the snapshot warmup keeps the
      # per-rebuild cost low (~3 ms baseline; jQuery / app bundle
      # re-evaluation dominates).
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
        @module_source_cache = nil
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

      # Called by V3Browser after each `__csimLoadDocument`. The first
      # successful call dumps the external script bodies that were
      # evaluated during the visit, builds (or loads from disk) the
      # app-warm snapshot, and points subsequent pool refills at it.
      # No-op on subsequent calls — once promoted, the runtime stays
      # on the app snapshot for the rest of its lifetime.
      def install_app_snapshot_if_needed
        return if @app_snapshot_installed
        return if ENV['CSIM_DISABLE_APP_SNAPSHOT'] == '1'
        return unless @ctx
        scripts = (ctx.eval('__csim_dumpExternalScripts()') rescue nil)
        return if scripts.nil? || scripts.empty?
        snap = self.class.app_snapshot_for(scripts)
        return unless snap
        @snapshot = snap
        @app_snapshot_installed = true
        drain_pool!
        refill_pool_async
      end

      def drain_pool!
        while (c = (@pool.pop(true) rescue nil))
          @@live_lock.synchronize { @@live.delete(c) }
          Thread.new { begin
            c.stop rescue nil
            c.dispose
          rescue StandardError
          end }
        end
      end

      def self.app_snapshot_for(scripts)
        hash = app_snapshot_key(scripts)
        @@app_snap_lock.synchronize {
          @@app_snap_cache[hash] ||= load_or_build_app_snapshot(hash, scripts)
        }
      end

      # Hash is keyed on the inputs that affect the resulting V8
      # startup blob: source bodies of bridge / wgxpath / each library,
      # plus library version strings (libv8 is the big one — its
      # internal V8 build version determines blob compatibility, and
      # loading a snapshot from a mismatched build CHECK-fails inside
      # V8).
      def self.app_snapshot_key(scripts)
        parts = [
          'capybara-simulated:v3:app-snap:v1',
          (Capybara::Simulated::VERSION rescue 'unknown'),
          (MiniRacer::VERSION rescue 'unknown'),
          (defined?(Libv8::Node::VERSION) ? Libv8::Node::VERSION : ''),
          File.read(BRIDGE_JS),
          File.read(WGXPATH_JS)
        ]
        scripts.sort_by {|s| s['url'].to_s }.each {|s|
          parts << s['url']
          parts << s['body']
        }
        Digest::SHA256.hexdigest(parts.join("\0"))
      end

      def self.load_or_build_app_snapshot(hash, scripts)
        path = File.join(cache_dir, "snapshot-#{hash}.bin")
        if File.exist?(path)
          begin
            return MiniRacer::Snapshot.load(File.binread(path))
          rescue StandardError => e
            warn "[capybara-simulated v3] app snapshot load failed (#{e.class}: #{e.message[0, 120]}); rebuilding"
          end
        end
        snap = build_app_snapshot(scripts)
        begin
          FileUtils.mkdir_p(File.dirname(path))
          tmp = "#{path}.#{Process.pid}.tmp"
          File.binwrite(tmp, snap.dump)
          File.rename(tmp, path)
        rescue StandardError => e
          warn "[capybara-simulated v3] app snapshot write failed: #{e.class}: #{e.message[0, 120]}"
        end
        snap
      end

      def self.build_app_snapshot(scripts)
        # Build the snapshot source: same prologue as the base snapshot,
        # then evaluate each captured library body at top level so
        # `function fooBar() {}` / `var foo = ...` declarations hoist
        # to the global scope. Wrapping each body in an IIFE silently
        # confines those declarations and breaks call sites like
        # `showModal(...)` that the on-attribute handlers rely on.
        # `eval(body)` invoked at module top runs in the surrounding
        # scope, which is what `<script>` tags do in real browsers.
        # We isolate failures per script via separate `eval(body)`
        # calls with try/catch so one bad bundle doesn't abort the
        # whole warmup.
        src = +SNAPSHOT_HOST_STUBS.dup
        src << File.read(BRIDGE_JS)
        src << File.read(WGXPATH_JS) << ";\n"
        src << "wgxpath.install(globalThis);\n"
        scripts.each {|s|
          url  = s['url'].to_s
          body = s['body'].to_s
          # Top-level body inside a try block; declarations hoist to
          # the enclosing (global) scope just like a real `<script>`.
          src << ";try {\n"
          src << body
          src << "\n} catch (e) { try { console.error('[csim warmup script]', #{url.to_json}, ':', e && e.message); } catch (_) {} }\n"
          src << "__csim_markScriptLoaded(#{url.to_json});\n"
        }
        src << "__csimEnterSnapshotState();\n"
        snap = MiniRacer::Snapshot.new(src)
        snap.warmup!(SNAPSHOT_WARMUP) rescue nil
        snap
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
        warn "[capybara-simulated v3] host fn error: #{e.class}: #{e.message[0, 200]}"
        nil
      end

      def attach_host_fns(c)
        browser = @browser
        sc      = method(:safe_call)
        c.attach('__rackFetch',                     ->(*a) { sc.() { browser.rack_fetch(a[0], a[1], a[2], a[3], a[4]) } })
        c.attach('__locationAssign',                ->(*a) { sc.() { browser.location_assign(a[0]); nil } })
        c.attach('__locationReload',                ->(*a) { sc.() { browser.refresh; nil } })
        c.attach('__setListenedType',               ->(*a) { sc.() { browser.set_listened_type(a[0], !!a[1]); nil } })
        c.attach('__setTimersActive',               ->(*a) { sc.() { browser.timers_active = !!a[0]; nil } })
        c.attach('__setIntersectionObserverActive', ->(*a) { sc.() { browser.intersection_observer_active = !!a[0]; nil } })
        c.attach('__setCurrentUrl',                 ->(*a) { sc.() { browser.history_state(a[0]); nil } })
        c.attach('__getDocumentCookie',             ->(*a) { sc.() { browser.document_cookie } })
        c.attach('__setDocumentCookie',             ->(*a) { sc.() { browser.write_document_cookie(a[0].to_s); nil } })
        c.attach('__modalDialog',                   ->(*a) { sc.() { browser.handle_modal(a[0], a[1], a[2]) } })
        c.attach('__csim_randomUUID',  ->(*a) { SecureRandom.uuid })
        c.attach('__csim_randomBytes', ->(*a) { SecureRandom.bytes(a[0].to_i).bytes })
        c.attach('__csim_atob',        ->(*a) { Base64.decode64(a[0].to_s) })
        c.attach('__csim_btoa',        ->(*a) { Base64.strict_encode64(a[0].to_s) })
        c.attach('__csim_utf8Encode',  ->(*a) { a[0].to_s.b.bytes })
        c.attach('__csim_utf8Decode',  ->(*a) { a[0].pack('C*').force_encoding('UTF-8') })
        c.attach('__csim_parseUrl',    ->(*a) { parse_url_for_js(a[0], a[1]) })
        c.attach('__csim_fetchModuleSource', ->(*a) { sc.() { fetch_module_source(browser, a[0]) } })
        c.attach('__csim_pushImportmap',     ->(*a) { sc.() { browser.set_importmap(a[0]); nil } })
      end

      # Fetch the rewritten module source for `url`. Cached per Context
      # so `__csim_require` only pays the EsmRewriter cost once per
      # URL per Context. Bridges Ruby-side `Browser#load_module`
      # (Rack fetch + rewrite) into the JS-side loader's
      # `__csim_fetchModuleSource(url)` hook.
      def fetch_module_source(browser, url)
        @module_source_cache ||= {}
        @module_source_cache[url] ||= begin
          raw = browser.load_module(url)
          raw && EsmRewriter.rewrite(raw).first
        end
      end

      def parse_url_for_js(input, base)
        require 'uri'
        u = base ? URI.join(base, input) : URI.parse(input)
        host = u.host || ''
        userinfo = u.userinfo.to_s.split(':', 2)
        {
          'href'     => u.to_s,
          'protocol' => "#{u.scheme}:",
          'username' => userinfo[0] || '',
          'password' => userinfo[1] || '',
          'host'     => u.port ? "#{host}:#{u.port}" : host,
          'hostname' => host,
          'port'     => u.port ? u.port.to_s : '',
          'pathname' => u.path || '/',
          'search'   => u.query ? "?#{u.query}" : '',
          'hash'     => u.fragment ? "##{u.fragment}" : '',
          'origin'   => u.scheme && host && !host.empty? ? "#{u.scheme}://#{host}#{u.port ? ":#{u.port}" : ''}" : 'null'
        }
      rescue StandardError
        {'error' => true}
      end
    end
  end
end
