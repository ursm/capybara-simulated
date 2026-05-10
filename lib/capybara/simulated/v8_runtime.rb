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

module Capybara
  module Simulated
    class V8Runtime
      BRIDGE_JS = File.expand_path('../../../vendor/js/bridge.js', __dir__).freeze

      # Web APIs V8 doesn't ship by default. Implemented as JS shims that
      # delegate the heavy lifting (URL parsing, base64) to Ruby callbacks
      # registered on the Context. Goal: cover bridge.js's surface area,
      # not pass WHATWG conformance.
      POLYFILL_PRELUDE = <<~JS.freeze
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
        @ctx&.dispose
        @ctx = nil
      end

      SCRIPT_TYPES_CLASSIC = Set['', 'text/javascript', 'application/javascript', 'application/ecmascript'].freeze

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
        warn "[capybara-simulated] script #{label} failed: #{e.message[0, 200]}"
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

      def attach_host_fns(c)
        browser = @browser
        # mini_racer's `attach` matches the JS callsite arity strictly,
        # so use variadic `*a` and pull the slots we care about — keeps
        # bridge.js callsites that drop trailing args (`__locationAssign(url)`
        # vs `__rackFetch(...5 args...)`) from blowing up at the host
        # boundary.
        c.attach('__dom',                       ->(*a) { browser.dom_op(a[0], a[1], a[2] || []) })
        c.attach('__addMutationObserverId',     ->(*a) { browser.add_mutation_observer_id(a[0].to_i) })
        c.attach('__removeMutationObserverId',  ->(*a) { browser.remove_mutation_observer_id(a[0].to_i) })
        c.attach('__setListenedType',           ->(*a) { browser.set_listened_type(a[0], !!a[1]) })
        c.attach('__setTimersActive',           ->(*a) { browser.timers_active = !!a[0] })
        c.attach('__modalDialog',               ->(*a) { browser.handle_modal(a[0], a[1], a[2]) })
        c.attach('__setCurrentUrl',             ->(*a) { browser.history_state(a[0]) })
        c.attach('__locationAssign',            ->(*a) { browser.location_assign(a[0]) })
        c.attach('__locationReload',            ->(*a) { browser.refresh })
        c.attach('__rackFetch',                 ->(*a) { browser.rack_fetch(a[0], a[1], a[2], a[3], a[4]) })
        c.attach('__getDocumentCookie',         ->(*a) { browser.document_cookie })
        c.attach('__setDocumentCookie',         ->(*a) { browser.write_document_cookie(a[0].to_s) })
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
