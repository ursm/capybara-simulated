# frozen_string_literal: true

# QuickJS-backed Runtime, alternate to `V8Runtime`. The DOM still lives
# in JS (same bridge.js, same wgxpath); this class swaps the engine to
# trade JIT speed for ~10× smaller per-VM footprint — useful when the
# scaling target is "many parallel workers on a fixed RAM budget"
# rather than absolute per-spec wall time.
#
# Surface mirrors `V8Runtime` exactly: `eval` / `call` / `drain_timers`
# / `drain_microtasks` / `settle_gen` / `has_ready_timer?` /
# `reset_timers` / `rebuild_ctx` / `reset_page`. Browser code is
# engine-agnostic.

require 'base64'
require 'json'
require 'securerandom'

require 'quickjs'

require_relative 'url_shape'

module Capybara
  module Simulated
    class QuickJSRuntime
      BRIDGE_JS  = File.expand_path('../../../vendor/js/bridge.js',  __dir__).freeze
      WGXPATH_JS = File.expand_path('../../../vendor/js/wgxpath.js', __dir__).freeze

      # Stub host fns so the bridge can be baked into the bytecode blob.
      # Mirrors `V8Runtime::SNAPSHOT_HOST_STUBS`; only the fns bridge.js
      # actually invokes appear here. Real implementations land via
      # `vm.define_function` after the bytecode runs on each fresh VM.
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
        globalThis.__csim_fetchModuleSource = function () { return null; };
        globalThis.__csim_pushImportmap     = function () { return null; };
        globalThis.__csim_logConsole        = function () { return null; };
      JS

      # Compile bridge.js + wgxpath into bytecode once per process. Every
      # per-visit VM replays this in ~10–20 ms (PR 31's microbench: 504KB
      # bundle in ~4 ms; bridge.js + wgxpath is ~10× larger). Side
      # effects (class definitions, `wgxpath.install(globalThis)`) run on
      # each new VM — `compile` itself is pure (`COMPILE_ONLY` flag).
      @@bridge_lock     = Mutex.new
      @@bridge_runnable = nil

      def self.bridge_runnable
        @@bridge_lock.synchronize { @@bridge_runnable ||= build_bridge_runnable }
      end

      def self.build_bridge_runnable
        src = SNAPSHOT_HOST_STUBS +
              File.read(BRIDGE_JS) +
              File.read(WGXPATH_JS) + ";\n" +
              "wgxpath.install(globalThis);\n"
        Quickjs::VM.new.compile(src, filename: 'csim_bridge.js')
      end

      def initialize(browser)
        @browser  = browser
        @vm       = nil
        @runnable = self.class.bridge_runnable
      end

      def eval(code)
        v = vm
        result = v.eval_code(code.to_s)
        pump_microtasks(v)
        normalize(result)
      end

      # mini_racer's `Context#call` drains the V8 microtask queue at
      # the end of every call (V8's default microtask policy). QuickJS
      # does not: `js_std_await` only pumps pending jobs while it's
      # waiting for an actual Promise to resolve, and host-fn returns
      # are plain values. Without a manual pump after every call,
      # Promise.then chains queued during a host-fn body (Turbo's
      # await fetch / Stimulus controllers, `evaluate_async_script`
      # test scripts) stall until the next async boundary. The
      # `await Promise.resolve(0)` post-pump routes through
      # `js_std_await`'s pending-job loop, draining everything queued
      # in the call.
      def call(name, *args)
        v = vm
        result = v.call(name.to_s, *args)
        pump_microtasks(v)
        normalize(result)
      end

      MICROTASK_PUMP_JS = 'await Promise.resolve(0)'.freeze
      private_constant :MICROTASK_PUMP_JS

      private def pump_microtasks(v)
        v.eval_code(MICROTASK_PUMP_JS)
      end

      # bridge.js owns the virtual clock; we drive it from Ruby because
      # Capybara's polling cadence is wall-clock-anchored.
      def drain_timers(max_ms = nil)
        max_ms.nil? ? vm.call('__drainTimers') : vm.call('__drainTimers', max_ms.to_i)
      end

      # `eval` and `call` already pump after every invocation, so this
      # explicit `drain_microtasks` is a no-op-shaped trigger that just
      # rolls the pump `iters` more times — useful for `settle` when a
      # `.then` chain has multiple promise hops to peel off per iter.
      def drain_microtasks(iters = 4)
        i = iters.to_i
        return if i <= 0
        v = vm
        i.times { pump_microtasks(v) }
      end

      def settle_gen
        vm.call('__settleGenGet').to_i
      end

      def has_ready_timer?
        return false if @vm.nil?
        !!vm.call('__hasReadyTimer')
      end

      def reset_timers
        return if @vm.nil?
        vm.call('__resetTimers')
      end

      # Tear down the current VM and build a fresh one from the
      # precompiled bytecode. Partial in-VM resets carry the same
      # library-init-leak hazards V8Runtime documents.
      def rebuild_ctx
        @vm = build_vm
      end

      # Same operation as `rebuild_ctx` since per-visit rebuilds are
      # already the inter-test reset point.
      def reset_page = rebuild_ctx

      private

      def vm
        @vm ||= build_vm
      end

      # bridge.js patches `Intl.DateTimeFormat`; mini_racer ships ICU
      # built-in but QuickJS gates it behind a polyfill flag. Other JS
      # surfaces bridge.js touches (URL / TextEncoder / atob/btoa /
      # crypto) are already routed through Ruby-side host fns, so
      # POLYFILL_INTL is the only one we strictly need.
      VM_FEATURES = [Quickjs::POLYFILL_INTL].freeze

      # `JS_SetMaxStackSize` measures C stack delta from runtime
      # construction; Ruby callers reach QuickJS through deep stacks
      # (Capybara `synchronize` + RSpec matchers + bridge.js's class
      # init closures), so the default 4 MB trips on routine
      # check_stale → __csimAlive calls. `0` disables the check; we
      # let the OS thread stack be the real ceiling.
      VM_MAX_STACK = 0

      # quickjs.rb default eval timeout is 100 ms; bridge.js's
      # `__csimEvaluateXPath` / `__csimDispatchEvent` chains routinely
      # exceed that on Avo-scale documents under QuickJS's interpreter.
      # 0 means "interrupt immediately" (the handler returns `elapsed
      # >= limit_ms`, so 0 fires on the first check), so bump to a
      # practical no-limit.
      VM_TIMEOUT_MS = (2**31) - 1

      def build_vm
        v = Quickjs::VM.new(features: VM_FEATURES, max_stack_size: VM_MAX_STACK, timeout_msec: VM_TIMEOUT_MS)
        @runnable.run(on: v)
        attach_host_fns(v)
        v
      end

      def safe_call
        yield
      rescue StandardError => e
        warn "[capybara-simulated] host fn error: #{e.class}: #{e.message[0, 200]}"
        nil
      end

      def attach_host_fns(v)
        browser = @browser
        sc      = method(:safe_call)
        v.define_function('__rackFetch')                { |*a| sc.() { browser.rack_fetch(a[0], a[1], a[2], a[3], a[4]) } }
        v.define_function('__locationAssign')           { |*a| sc.() { browser.location_assign(a[0]); nil } }
        v.define_function('__locationReload')           { |*a| sc.() { browser.location_reload; nil } }
        v.define_function('__setTimersActive')          { |*a| sc.() { browser.timers_active = !!a[0]; nil } }
        v.define_function('__setCurrentUrl')            { |*a| sc.() { browser.history_state(a[0]); nil } }
        v.define_function('__pushHistoryEntry')         { |*a| sc.() { browser.history_push(a[0]); nil } }
        v.define_function('__csimReadFilePick')         { |*a| sc.() { browser.read_file_pick(a[0], a[1], a[2], a[3]) } }
        v.define_function('__getDocumentCookie')        { |*_| sc.() { browser.document_cookie } }
        v.define_function('__setDocumentCookie')        { |*a| sc.() { browser.write_document_cookie(a[0].to_s); nil } }
        v.define_function('__csim_storageGet')          { |*a| sc.() { browser.storage_get(a[0], a[1]) } }
        v.define_function('__csim_storageSet')          { |*a| sc.() { browser.storage_set(a[0], a[1], a[2]); nil } }
        v.define_function('__csim_storageRemove')       { |*a| sc.() { browser.storage_remove(a[0], a[1]); nil } }
        v.define_function('__csim_storageClear')        { |*a| sc.() { browser.storage_clear(a[0]); nil } }
        v.define_function('__csim_storageKey')          { |*a| sc.() { browser.storage_key(a[0], a[1]) } }
        v.define_function('__csim_storageLength')       { |*a| sc.() { browser.storage_length(a[0]) } }
        v.define_function('__modalDialog')              { |*a| sc.() { browser.handle_modal(a[0], a[1], a[2]) } }
        v.define_function('__csim_randomUUID')          { |*_| SecureRandom.uuid }
        v.define_function('__csim_randomBytes')         { |*a| SecureRandom.bytes(a[0].to_i).bytes }
        v.define_function('__csim_atob')                { |*a| Base64.decode64(a[0].to_s) }
        v.define_function('__csim_btoa')                { |*a| Base64.strict_encode64(a[0].to_s) }
        v.define_function('__csim_utf8Encode')          { |*a| a[0].to_s.b.bytes }
        v.define_function('__csim_utf8Decode')          { |*a| a[0].pack('C*').force_encoding('UTF-8') }
        v.define_function('__csim_parseUrl')            { |*a| UrlShape.parse_for_js(a[0], a[1]) }
        v.define_function('__csim_fetchModuleSource')   { |*a| sc.() { browser.load_module(a[0]) } }
        v.define_function('__csim_pushImportmap')       { |*a| sc.() { browser.set_importmap(a[0]); nil } }
        v.define_function('__csim_logConsole')          { |*a| sc.() { browser.log_console(a[0], a[1]); nil } }
      end

      # QuickJS marshals JS `undefined` as the symbol
      # `Quickjs::Value::UNDEFINED`; mini_racer marshals it as `nil`. The
      # rest of the gem expects `nil`, so normalize at the boundary.
      # NaN gets the same treatment for consistency (the bridge never
      # surfaces it as a load-bearing value).
      UNDEFINED = Quickjs::Value::UNDEFINED
      NAN       = Quickjs::Value::NAN

      def normalize(value)
        case value
        when UNDEFINED, NAN then nil
        when Hash  then value.transform_values {|v| normalize(v) }
        when Array then value.map {|v| normalize(v) }
        else value
        end
      end
    end
  end
end
