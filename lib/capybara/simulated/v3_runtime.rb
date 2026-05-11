# frozen_string_literal: true

# v3 runtime: mini_racer Context wrapper for the all-in-V8 architecture
# (DOM lives in JS, no Nokogiri tree). Surface mirrors `V8Runtime` so
# the rest of the gem doesn't need to know which v we're on.

require 'mini_racer'
require 'base64'
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

      def self.build_snapshot
        # Order matters: v3_bridge installs `globalThis.Document` (etc.)
        # first, then wgxpath patches `Document.prototype.evaluate` on
        # top, then the install-on-current-document line ties it to the
        # live `document` instance the bridge created.
        src = SNAPSHOT_HOST_STUBS +
              File.read(BRIDGE_JS) +
              File.read(WGXPATH_JS) + ";\n" +
              "wgxpath.install(globalThis);\n"
        MiniRacer::Snapshot.new(src)
      end

      def initialize(browser)
        @browser = browser
        @ctx     = nil
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

      def reset_page
        # Unlike v2, v3's Context survives navigation — we just call
        # `__resetPage` on the JS side to drop the document state.
        # The single Context per Browser keeps JIT state warm across
        # page loads, which is one of v3's main wins.
        return if @ctx.nil?
        ctx.eval('__resetPage()')
      end

      def ctx
        @ctx ||= boot_ctx
      end

      def boot_ctx
        c = MiniRacer::Context.new(snapshot: self.class.snapshot)
        attach_host_fns(c)
        @@live_lock.synchronize { @@live << c }
        @ctx = c
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
