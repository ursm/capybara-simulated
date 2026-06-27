# frozen_string_literal: true

require 'base64'
require 'openssl'
require 'securerandom'

require_relative 'webauthn_state'


module Capybara
  module Simulated
    # Bits common to `V8Runtime` and `QuickJSRuntime` — JS asset paths,
    # the host-fn table that bridge.js reaches back through, the
    # error-swallowing wrapper. Each engine plugs the table into its
    # own attach API (rusty_racer's `Context#attach` vs quickjs.rb's
    # `Quickjs::VM#define_function`).
    module RuntimeShared
      BRIDGE_JS         = File.expand_path('js/bridge.bundle.js',                 __dir__).freeze
      SNAPSHOT_STUBS_JS = File.expand_path('js/snapshot_stubs.js',                __dir__).freeze
      VENDOR_BUNDLE_JS  = File.expand_path('../../../vendor/js/vendor.bundle.js', __dir__).freeze

      def self.snapshot_stubs_src = File.read(SNAPSHOT_STUBS_JS)
      def self.bridge_src         = File.read(BRIDGE_JS)
      def self.vendor_bundle_src  = File.read(VENDOR_BUNDLE_JS)

      # Combined source baked into the V8 Snapshot / QuickJS bytecode.
      # Order matters: stubs first (so bridge's IIFE can reference the
      # `globalThis.__rackFetch` etc. slots), then the vendor bundle
      # (so bridge can reference `globalThis.__csimVendor.cssSelect` and
      # `.xpathway`), then bridge proper — which installs the xpathway-backed
      # `Document.prototype.evaluate` itself (see js/src/xpath.js). The
      # standalone xpathway engine in the vendor blob replaces the old wgxpath.
      def self.snapshot_src
        snapshot_stubs_src +
          vendor_bundle_src + ";\n" +
          bridge_src
      end

      # Host fns whose body touches `Browser` — wrap with `safe_call`
      # so a Ruby-side bug in the Browser path doesn't propagate as a
      # JS exception that crashes the whole script chain. Bodies take
      # `(browser, *js_args)` and return whatever the JS caller expects.
      BROWSER_HOST_FNS = {
        '__rackFetch'                => ->(b, *a) { b.rack_fetch(a[0], a[1], a[2], a[3], a[4]) },
        '__csimExternalAsset'        => ->(b, *a) { b.external_asset_source(a[0]) },
        '__locationAssign'           => ->(b, *a) { b.location_assign(a[0]); nil },
        '__locationReload'           => ->(b, *_) { b.location_reload; nil },
        # A nested browsing context navigating its OWN location (a[1] = the frame's
        # realm id). Deferred + applied by re-navigating the owning iframe, so a
        # frame's `location.href = …` navigates the frame, not the top page.
        '__csimFrameNavigate'        => ->(b, *a) { b.frame_navigate_self(a[0], a[1].to_i); nil },
        # A nested browsing context reloading its OWN location (a[0] = the frame's
        # realm id). Deferred + applied by re-navigating the owning iframe to its
        # current document — see Browser#frame_reload_self.
        '__csimFrameReload'          => ->(b, *a) { b.frame_reload_self(a[0].to_i); nil },
        # A <form> submitted from inside a nested browsing context (a[0] = the
        # initiating frame's realm id). Deferred + applied against that realm,
        # like __csimFrameNavigate — see Browser#frame_submit_self.
        '__csimFrameSubmit'          => ->(b, *a) { b.frame_submit_self(a[0].to_i); nil },
        '__setTimersActive'          => ->(b, *a) { b.timers_active = !!a[0]; nil },
        '__setCurrentUrl'            => ->(b, *a) { b.history_state(a[0], a[1]); nil },
        '__pushHistoryEntry'         => ->(b, *a) { b.history_push(a[0], a[1]); nil },
        '__historyGo'                => ->(b, *a) { b.history_go(a[0]); nil },
        '__historyLength'            => ->(b, *_) { b.history_length },
        '__csimReadFilePick'         => ->(b, *a) { b.read_file_pick(a[0], a[1], a[2], a[3]) },
        '__getDocumentCookie'        => ->(b, *_) { b.document_cookie },
        '__setDocumentCookie'        => ->(b, *a) { b.write_document_cookie(a[0].to_s); nil },
        '__getDocumentReferrer'      => ->(b, *_) { b.current_referer },
        '__csim_storageGet'          => ->(b, *a) { b.storage_get(a[0], a[1]) },
        '__csim_storageSet'          => ->(b, *a) { b.storage_set(a[0], a[1], a[2]); nil },
        '__csim_storageRemove'       => ->(b, *a) { b.storage_remove(a[0], a[1]); nil },
        '__csim_storageClear'        => ->(b, *a) { b.storage_clear(a[0]); nil },
        '__csim_storageKey'          => ->(b, *a) { b.storage_key(a[0], a[1]) },
        '__csim_storageLength'       => ->(b, *a) { b.storage_length(a[0]) },
        '__csimGeolocationState'     => ->(b, *_) { b.geolocation_state_json },
        '__modalDialog'              => ->(b, *a) { b.handle_modal(a[0], a[1], a[2]) },
        '__csim_pushImportmap'       => ->(b, *a) { b.set_importmap(a[0]); nil },
        '__csim_logConsole'          => ->(b, *a) { b.log_console(a[0], a[1]); nil },
        '__csim_eventSourceOpen'     => ->(b, *a) { b.event_source_open(a[0]) },
        '__csim_eventSourceClose'    => ->(b, *a) { b.event_source_close(a[0]); nil },
        '__csim_wsOpen'              => ->(b, *a) { b.ws_open(a[0], a[1]) },
        '__csim_wsSend'              => ->(b, *a) { b.ws_send(a[0], a[1], a[2], a[3]); nil },
        '__csim_wsClose'             => ->(b, *a) { b.ws_close(a[0], a[1], a[2]); nil },
        '__csim_rackFetchAsync'      => ->(b, *a) { b.rack_fetch_async(a[0], a[1], a[2], a[3]) },
        '__csim_rackFetchAsyncAbort' => ->(b, *a) { b.rack_fetch_async_abort(a[0]); nil },
        # Cross-window references (window.open / opener / postMessage). Each
        # window is a separate VM, so these forward to the Driver to route to
        # the target window's Browser.
        '__csimWindowOpen'           => ->(b, *a) { b.open_child_window(a[0], a[1]) },
        '__csimWindowPostMessage'    => ->(b, *a) { b.post_message_to_window(a[0], a[1], a[2]); nil },
        '__csimBroadcast'            => ->(b, *a) { b.broadcast_to_windows(a[0], a[1]); nil },
        '__csimWindowGet'            => ->(b, *a) { b.window_get(a[0], a[1]) },
        '__csimWindowDocGet'         => ->(b, *a) { b.window_doc_get(a[0], a[1]) },
        # Cross-window remote-ref RPC: route an opener's node/object proxy op to
        # the target window's VM (a[0]=window handle, a[1]=ref id, a[2]=prop/method).
        '__csimWindowRefGet'         => ->(b, *a) { b.window_ref_get(a[0], a[1], a[2]) },
        '__csimWindowRefSet'         => ->(b, *a) { b.window_ref_set(a[0], a[1], a[2], a[3]); nil },
        '__csimWindowRefCall'        => ->(b, *a) { b.window_ref_call(a[0], a[1], a[2], a[3]) },
        '__csimWindowLocation'       => ->(b, *a) { b.window_location_of(a[0]) },
        '__csimWindowSetLocation'    => ->(b, *a) { b.set_window_location(a[0], a[1]); nil },
        '__csimWindowClosed'         => ->(b, *a) { b.window_closed?(a[0]) },
        '__csimWindowClose'          => ->(b, *a) { b.close_child_window(a[0]); nil },
        '__csimWindowOpener'         => ->(b, *_) { b.opener_handle },
        # Fire an aux window's OWN `load` event (in its VM) — deferred by the
        # opener so a child `window.onload` runs after the opener's current task.
        '__csimFireAuxWindowLoad'    => ->(b, *a) { b.fire_aux_window_load(a[0]); nil },
        '__csim_workerSpawn'         => ->(b, *a) { b.worker_spawn(a[0], shared: !!a[1]) },
        '__csim_workerPostToWorker'  => ->(b, *a) { b.worker_post_to_worker(a[0], a[1]); nil },
        '__csim_workerTerminate'     => ->(b, *a) { b.worker_terminate(a[0]); nil },
        '__csim_decodeImage'         => ->(b, *a) { b.decode_image(a[0], a[1], a[2]) },
        '__csim_blobRegister'        => ->(b, *a) { b.blob_register(a[0], a[1], a[2]); nil },
        # WHATWG/UTS46 IDNA for the URL parser's host processing (the JS tr46 stub
        # delegates non-ASCII / xn-- hosts here; ASCII stays in-VM).
        '__csim_domainToASCII'       => ->(b, *a) { b.domain_to_ascii(a[0]) },
        '__csim_domainToUnicode'     => ->(b, *a) { b.domain_to_unicode(a[0]) },
        '__csim_blobResolve'         => ->(b, *a) { b.blob_resolve(a[0]) },
        '__csim_blobUnregister'      => ->(b, *a) { b.blob_unregister(a[0]); nil },
        # Any non-timer async channel (worker / SSE / hijacked fetch / window
        # message / websocket) still in flight — the WPT runner's drain consults
        # this so it doesn't bail before an async message (e.g. a freshly-spawned
        # worker's first postMessage) has had a chance to land.
        '__csim_asyncIoPending'      => ->(b, *_a) { b.async_io_pending? },
        '__csim_transferStash'       => ->(b, *a) { b.transfer_buffer_stash(a[0]) },
        '__csim_transferFetch'       => ->(b, *a) { b.transfer_buffer_fetch_for_js(a[0]) },
        # Zero-copy postMessage transfer-token bookkeeping (see Browser#drop_pending_transfers).
        '__csim_transferIssued'      => ->(b, *a) { b.transfer_token_issued(a[0]); nil },
        # Universal-server context (WPT runner)? Gates cross-origin eager frame
        # building: only there is a cross-origin iframe's content served locally,
        # so an ordinary app leaves cross-origin frames lazy (= baseline) and never
        # eager-@app.calls a foreign URL (side effects: extra visit / log row).
        '__csim_allHostsLocal'       => ->(b, *a) { b.send(:all_hosts_local?) },
        '__csim_decodeVideoFrame'    => ->(b, *a) { b.decode_video_frame(a[0]) },
        '__csim_encodeImage'         => ->(b, *a) { b.encode_image(a[0], a[1], a[2], a[3], a[4]) },
        # WebAuthn create / get raise `WebauthnState::Error` carrying
        # the DOMException name (`InvalidStateError`, …); rescue here
        # so the JS shim sees `{error:, name:}` instead of the
        # `safe_call`-flattened nil that would collapse every failure
        # to a generic NotAllowedError.
        '__csimWebauthnCreate' => ->(b, *a) {
          begin b.webauthn.create(a[0]); rescue WebauthnState::Error => e
            {'error' => e.message, 'name' => e.webauthn_name}
          end
        },
        '__csimWebauthnGet' => ->(b, *a) {
          begin b.webauthn.get(a[0]); rescue WebauthnState::Error => e
            {'error' => e.message, 'name' => e.webauthn_name}
          end
        },
        '__csimWebauthnAddVirtualAuthenticator'    => ->(b, *a) { b.webauthn.add_virtual_authenticator(a[0]) },
        '__csimWebauthnRemoveVirtualAuthenticator' => ->(b, *a) { b.webauthn.remove_virtual_authenticator(a[0]); nil },
        '__csimWebauthnAddCredential'              => ->(b, *a) { b.webauthn.add_credential(a[0], a[1]); nil },
        '__csimWebauthnRemoveCredential'           => ->(b, *a) { b.webauthn.remove_credential(a[0], a[1]); nil },
        '__csimWebauthnGetCredentials'             => ->(b, *a) { b.webauthn.get_credentials(a[0]) },
        '__csimWebauthnSetUserVerified'            => ->(b, *a) { b.webauthn.set_user_verified(a[0], a[1]); nil }
      }.freeze

      # Host fns that route to pure stdlib — no Browser surface,
      # nothing to safe_call, no allocation needed for the wrap. Skip
      # the rescue overhead on every per-find / per-event invocation.
      # Process-wide cascade-rule cache (mirrors the script bytecode cache). The
      # built {hide, layout} rules are deterministic per (stylesheet-set,
      # viewport), so the JS side caches the serialized rules keyed by a digest of
      # the sheet sources and skips the ~12-15 ms css-tree parse + per-rule
      # specificity + terminalKey rebuild on every per-visit VM rebuild. Lives in
      # Ruby (not the VM) so it survives `rebuild_ctx`. Key space is tiny (one app
      # ships one stylesheet set), so the map stays small; no eviction needed.
      CASCADE_RULE_CACHE       = {}
      CASCADE_RULE_CACHE_MUTEX = Mutex.new

      # Process-wide PER-SHEET parse cache (companion to CASCADE_RULE_CACHE). The
      # built whole-cascade is cached above, but it misses whenever a page's inline
      # `<style>` changes (Avo injects per-page styles), forcing a rebuild that
      # re-parses every sheet — including unchanged linked bundles (avo.base.css).
      # `parseSheet` is pure, so the JS side caches its serialized `{hide,layout}`
      # keyed by (cssText hash, viewport) here, surviving the per-visit VM rebuild
      # that wipes the in-VM `__sheetCache` — the CSS analogue of the JS bytecode
      # cache. Keyed by content, so a content change yields a new key. Capped.
      SHEET_PARSE_CACHE       = {}
      SHEET_PARSE_CACHE_MUTEX = Mutex.new
      SHEET_PARSE_CACHE_MAX   = 2048

      STDLIB_HOST_FNS = {
        '__csimCascadeCacheGet' => ->(*a) { CASCADE_RULE_CACHE_MUTEX.synchronize { CASCADE_RULE_CACHE[a[0].to_s] } },
        '__csimCascadeCachePut' => lambda {|*a|
          CASCADE_RULE_CACHE_MUTEX.synchronize { CASCADE_RULE_CACHE[a[0].to_s] = a[1].to_s }
          nil
        },
        '__csimSheetCacheGet' => ->(*a) { SHEET_PARSE_CACHE_MUTEX.synchronize { SHEET_PARSE_CACHE[a[0].to_s] } },
        '__csimSheetCachePut' => lambda {|*a|
          SHEET_PARSE_CACHE_MUTEX.synchronize {
            SHEET_PARSE_CACHE.clear if SHEET_PARSE_CACHE.size >= SHEET_PARSE_CACHE_MAX
            SHEET_PARSE_CACHE[a[0].to_s] = a[1].to_s
          }
          nil
        },
        '__csim_randomUUID'   => ->(*_) { SecureRandom.uuid },
        '__csim_randomBytes'  => ->(*a) { SecureRandom.bytes(a[0].to_i).bytes },
        '__csim_atob'         => ->(*a) { Base64.decode64(a[0].to_s) },
        '__csim_btoa'         => ->(*a) { Base64.strict_encode64(a[0].to_s) },
        '__csim_utf8Encode'   => ->(*a) { a[0].to_s.b.bytes },
        '__csim_utf8Decode'   => ->(*a) { a[0].pack('C*').force_encoding('UTF-8') },
        # `__csim_parseUrl` is defined in JS now (js/src/url-parse.js, backed by
        # the vendored whatwg-url) — spec-correct + no V8↔Ruby boundary per parse.
        # Web Crypto SubtleCrypto.digest — algo is "SHA-1"/"SHA-256"/etc.
        # JS hands us the byte array; we return the digest as bytes.
        '__csim_subtleDigest' => lambda {|*a|
          algo  = a[0].to_s.upcase.tr('-', '')
          bytes = a[1].is_a?(Array) ? a[1].pack('C*') : a[1].to_s
          OpenSSL::Digest.new(algo).digest(bytes).bytes
        }
      }.freeze

      def self.safe_call
        yield
      rescue StandardError => e
        warn "[capybara-simulated] host fn error: #{e.class}: #{e.message[0, 200]}"
        warn "  at #{e.backtrace&.first(4)&.join("\n  at ")}" if ENV['CSIM_HOSTFN_TRACE'] == '1'
        nil
      end

      # Re-tag a text string for the Ruby→JS crossing. Marshalling is
      # tag-driven: a BINARY-tagged String crosses as a Uint8Array, and a
      # UTF-8-tagged string with invalid bytes raises — but Rack bodies,
      # socket reads, and header values all arrive BINARY-tagged even when
      # they ARE text. Decoding response bytes into text is the document
      # layer's job (csim owns the charset knowledge; the contract is UTF-8),
      # so every text crossing funnels through here: re-tag as UTF-8, scrub
      # only actually-invalid bytes.
      def self.utf8_text(s)
        s = s.dup.force_encoding(Encoding::UTF_8) unless s.encoding == Encoding::UTF_8
        s.valid_encoding? ? s : s.scrub
      end
    end
  end
end
