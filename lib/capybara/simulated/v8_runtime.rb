# frozen_string_literal: true

# Experimental V8 backend, opt-in via `CSIM_JS_ENGINE=v8`. Mirrors
# `JsRuntime`'s public surface so `Browser` doesn't need to know which
# engine is active. mini_racer's `MiniRacer::Context` plays the role of
# `Quickjs::VM`; each test boundary swaps in a fresh Context loaded from
# a process-wide warmed snapshot so the bridge code starts hot.

require 'mini_racer'
require 'base64'
require 'securerandom'
require 'set'
require 'digest'

# V8 flag setup. Must run before the first `MiniRacer::Context.new`;
# idempotent calls raise `PlatformAlreadyInitialized`.
#
# `stack_size` widens V8's stack guard so deep jQuery 3 + Stimulus
# event-handler chains fit. `CSIM_V8_STACK_KB=N` overrides; default 2
# MiB fits comfortably inside the 8 MiB pthread cap.
#
# We deliberately do *not* pass `:single_threaded` — that flag is
# incompatible with mini_racer's rendezvous-based call model. With it
# set, V8 has no worker thread to consume scheduled tasks, so
# `Context#eval` blocks on `rendezvous_nogvl → pthread_mutex_lock`
# forever inside the Rails test runner (confirmed via gdb backtrace).
# The original reason we tried `:single_threaded` was that multi-
# threaded V8 SIGSEGV'd on Redmine's jQuery+UI bundle, but that root
# cause was actually `isPlainObject(globalThis)` recursion — fixed by
# tagging globalThis [object Window] in `POLYFILL_PRELUDE`.
begin
  stack_kb = (ENV['CSIM_V8_STACK_KB'] || '2000').to_i
  MiniRacer::Platform.set_flags!(stack_size: stack_kb)
rescue MiniRacer::PlatformAlreadyInitialized
  # Another callsite beat us to it; either the prior caller picked a
  # compatible value or they're testing the platform-init path.
end

module Capybara
  module Simulated
    class V8Runtime
      BRIDGE_JS = File.expand_path('../../../vendor/js/bridge.js', __dir__).freeze

      # Web APIs V8 doesn't ship by default. Implemented as JS shims that
      # delegate the heavy lifting (URL parsing, base64) to Ruby callbacks
      # registered on the Context. Goal: cover bridge.js's surface area,
      # not pass WHATWG conformance.
      POLYFILL_PRELUDE = <<~JS.freeze
        // V8's bare globalThis reports as `[object Object]` (no built-in
        // Symbol.toStringTag), so jQuery's `isPlainObject(globalThis)`
        // returns true. Any deep-clone library (jQuery UI's
        // `widget.extend`, lodash's `cloneDeep`, …) that walks plain-
        // object properties then dives into the global and never returns
        // — globalThis is full of cycles. Real browsers tag it `[object
        // Window]`, so we do the same.
        Object.defineProperty(globalThis, Symbol.toStringTag, { value: 'Window' });
        // crypto.randomUUID + getRandomValues
        globalThis.crypto = {
          randomUUID()              { return __csim_randomUUID(); },
          getRandomValues(arr) {
            const bytes = __csim_randomBytes(arr.length);
            for (let i = 0; i < arr.length; i++) arr[i] = bytes[i];
            return arr;
          }
        };
        // base64
        globalThis.atob = (s) => __csim_atob(String(s));
        globalThis.btoa = (s) => __csim_btoa(String(s));
        // TextEncoder / TextDecoder (UTF-8 only — bridge.js doesn't use
        // other encodings).
        globalThis.TextEncoder = class TextEncoder {
          get encoding() { return 'utf-8'; }
          encode(s)     { return new Uint8Array(__csim_utf8Encode(String(s ?? ''))); }
        };
        globalThis.TextDecoder = class TextDecoder {
          constructor(label = 'utf-8') { this._label = label; }
          get encoding() { return this._label; }
          decode(buf) {
            const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
            return __csim_utf8Decode(Array.from(arr));
          }
        };
        // URL / URLSearchParams — minimal, anchor-element-style parsing
        // via Ruby's URI. Sufficient for the bridge's own URL bookkeeping
        // (resolve, hostname, pathname, searchParams). Not WHATWG-spec-
        // compliant on edge cases.
        globalThis.URL = class URL {
          constructor(input, base) {
            const r = __csim_parseUrl(String(input), base ? String(base) : null);
            if (r.error) throw new TypeError('Invalid URL: ' + input);
            this.href     = r.href;
            this.protocol = r.protocol;
            this.username = r.username;
            this.password = r.password;
            this.host     = r.host;
            this.hostname = r.hostname;
            this.port     = r.port;
            this.pathname = r.pathname;
            this.search   = r.search;
            this.hash     = r.hash;
            this.origin   = r.origin;
            this._params  = null;
          }
          get searchParams() { return this._params ||= new URLSearchParams(this.search); }
          toString()         { return this.href; }
          toJSON()           { return this.href; }
          static canParse(input, base) {
            return !__csim_parseUrl(String(input), base ? String(base) : null).error;
          }
        };
        globalThis.URLSearchParams = class URLSearchParams {
          constructor(init) {
            this._pairs = [];
            if (typeof init === 'string') {
              const s = init.startsWith('?') ? init.slice(1) : init;
              if (s) for (const part of s.split('&')) {
                const eq = part.indexOf('=');
                const k = eq < 0 ? part : part.slice(0, eq);
                const v = eq < 0 ? '' : part.slice(eq + 1);
                this._pairs.push([decodeURIComponent(k.replace(/\\+/g, ' ')), decodeURIComponent(v.replace(/\\+/g, ' '))]);
              }
            } else if (init && typeof init[Symbol.iterator] === 'function') {
              for (const [k, v] of init) this._pairs.push([String(k), String(v)]);
            } else if (init && typeof init === 'object') {
              for (const k of Object.keys(init)) this._pairs.push([String(k), String(init[k])]);
            }
          }
          append(k, v) { this._pairs.push([String(k), String(v)]); }
          delete(k)    { this._pairs = this._pairs.filter(([n]) => n !== String(k)); }
          get(k)       { const p = this._pairs.find(([n]) => n === String(k)); return p ? p[1] : null; }
          getAll(k)    { return this._pairs.filter(([n]) => n === String(k)).map(([, v]) => v); }
          has(k)       { return this._pairs.some(([n]) => n === String(k)); }
          set(k, v)    { this.delete(k); this.append(k, v); }
          *entries()   { for (const p of this._pairs) yield p; }
          *keys()      { for (const [k] of this._pairs) yield k; }
          *values()    { for (const [, v] of this._pairs) yield v; }
          [Symbol.iterator]() { return this.entries(); }
          forEach(fn)  { for (const [k, v] of this._pairs) fn(v, k, this); }
          toString() {
            return this._pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
          }
          get size() { return this._pairs.length; }
        };
      JS

      def initialize(browser, extra_features: [])
        @browser = browser
        @ctx     = nil
      end

      def eval(code)
        ctx.eval(code.to_s)
      end

      def call(name, *args)
        ctx.call(name, *args)
        # mini_racer doesn't separately pump microtasks; eval drains them
        # before returning. Keep the no-op for parity with JsRuntime.
      end

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
        # Drop the slot rather than calling `dispose`. Explicit dispose
        # races with V8's GC when bridge.js still holds Ruby callback
        # refs (the lambdas attached via `attach`); leaving GC to clean
        # up sidesteps a SIGSEGV on the next test boot.
        @ctx = nil
      end

      def run_scripts(browser, document)
        document.css('script').each do |script|
          case script['type'].to_s
          when 'module'    then run_module_script(browser, script)
          when 'importmap' then next
          else
            run_classic_script(browser, script) if SCRIPT_TYPES_CLASSIC.include?(script['type'].to_s)
          end
        end
      end

      def run_classic_script(browser, script)
        src = script['src']
        if src && !src.empty?
          body = browser.fetch_resource(browser.resolve(src))
          eval_safely(body, src) if body
        else
          eval_safely(script.text, '<inline>')
        end
      end

      def run_module_script(_browser, _script)
        # mini_racer doesn't expose ES-module loading. Avo / importmap-
        # based apps need the QuickJS engine until this gap is filled.
      end

      def eval_module_entry(_url)
        # See run_module_script.
      end

      def eval_safely(code, label)
        return if code.nil? || code.empty?
        ctx.eval(code)
      rescue MiniRacer::RuntimeError, MiniRacer::ParseError, MiniRacer::ScriptTerminatedError => e
        # Stack traces matter for `RangeError: Maximum call stack size
        # exceeded` — we need the JS call site (usually inside jQuery+UI
        # init) to know which proxy chain blew the V8 stack. Dump the full
        # message + backtrace under `CSIM_V8_TRACE=1`.
        if ENV['CSIM_V8_TRACE'] == '1'
          warn "[capybara-simulated] script #{label} failed: #{e.class}: #{e.message}"
          warn e.backtrace&.first(20)&.join("\n")
        else
          warn "[capybara-simulated] script #{label} failed: #{e.message[0, 200]}"
        end
      end

      private

      # Process-wide snapshot warmed with bridge.js so each fresh Context
      # starts post-bridge-load.
      @@snapshot_lock = Mutex.new
      @@snapshot      = nil

      def self.snapshot
        @@snapshot_lock.synchronize {
          @@snapshot ||= build_snapshot
        }
      end

      def self.build_snapshot
        # Snapshot can't capture Ruby-callback registration — host
        # functions get re-attached on every Context. Polyfills that need
        # Ruby callbacks (URL, base64, …) are deferred to post-attach
        # eval; the snapshot only carries pure JS pieces.
        snap = MiniRacer::Snapshot.new('')
        snap
      end

      def ctx
        @ctx ||= boot_ctx
      end

      def boot_ctx
        c = MiniRacer::Context.new(snapshot: self.class.snapshot)
        attach_host_fns(c)
        c.eval(POLYFILL_PRELUDE)
        c.eval(File.read(BRIDGE_JS))
        @ctx = c
      end

      # mini_racer's Ruby→JS converter handles Hash, Array, primitives —
      # but not Set / Range / Symbol-keyed Hashes / etc. `Browser#dom_op`
      # legitimately returns Sets in some places (e.g. `data-controller`
      # tokens). Recursively coerce on the way out so the bridge sees a
      # plain JS Array.
      def to_js_value(v)
        case v
        when Set, Range
          v.to_a.map {|x| to_js_value(x) }
        when Array
          v.map {|x| to_js_value(x) }
        when Hash
          v.transform_keys(&:to_s).transform_values {|x| to_js_value(x) }
        when Symbol
          v.to_s
        else
          v
        end
      end

      # mini_racer corrupts V8 internal state if a Ruby exception
      # propagates out of an attached lambda — the next operation on the
      # Context segfaults somewhere deep in V8. Catch every error inside
      # the host fn and substitute nil; let bridge.js see "host op
      # returned nothing" rather than tearing the isolate down.
      def safe_call
        yield
      rescue StandardError => e
        warn "[capybara-simulated v8] host fn error: #{e.class}: #{e.message[0, 200]}"
        nil
      end

      def attach_host_fns(c)
        browser = @browser
        coerce  = method(:to_js_value)
        sc      = method(:safe_call)
        # mini_racer's `attach` matches the JS callsite arity strictly,
        # so use variadic `*a` and pull the slots we care about — keeps
        # bridge.js callsites that drop trailing args (`__locationAssign(url)`
        # vs `__rackFetch(...5 args...)`) from blowing up at the host
        # boundary.
        c.attach('__dom',                       ->(*a) { sc.() { coerce.(browser.dom_op(a[0], a[1], a[2] || [])) } })
        c.attach('__addMutationObserverId',     ->(*a) { sc.() { browser.add_mutation_observer_id(a[0].to_i); nil } })
        c.attach('__removeMutationObserverId',  ->(*a) { sc.() { browser.remove_mutation_observer_id(a[0].to_i); nil } })
        c.attach('__setListenedType',           ->(*a) { sc.() { browser.set_listened_type(a[0], !!a[1]); nil } })
        c.attach('__setTimersActive',           ->(*a) { sc.() { browser.timers_active = !!a[0]; nil } })
        c.attach('__modalDialog',               ->(*a) { sc.() { coerce.(browser.handle_modal(a[0], a[1], a[2])) } })
        c.attach('__setCurrentUrl',             ->(*a) { sc.() { browser.history_state(a[0]); nil } })
        c.attach('__locationAssign',            ->(*a) { sc.() { browser.location_assign(a[0]); nil } })
        c.attach('__locationReload',            ->(*a) { sc.() { browser.refresh; nil } })
        c.attach('__rackFetch',                 ->(*a) { sc.() { coerce.(browser.rack_fetch(a[0], a[1], a[2], a[3], a[4])) } })
        c.attach('__getDocumentCookie',         ->(*a) { sc.() { browser.document_cookie } })
        c.attach('__setDocumentCookie',         ->(*a) { sc.() { browser.write_document_cookie(a[0].to_s); nil } })
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
