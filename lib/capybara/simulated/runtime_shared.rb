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
        '__rackFetch'                => ->(b, *a) { b.rack_fetch(a[0], a[1], a[2], a[3], a[4], a[5], credentials: a[6] || 'same-origin', referrer_policy: a[7], referrer: a[8], cache_mode: a[9] || 'default', initiator: a[10], site_seed: a[11], origin_null: a[12], client_url: a[13], cookie_cross_site: a[14] == true, nav_dest: a[15]) },
        '__csimExternalAsset'        => ->(b, *a) { b.external_asset_source(a[0]) },
        '__locationAssign'           => ->(b, *a) { b.location_assign(a[0]); nil },
        '__locationReload'           => ->(b, *_) { b.location_reload; nil },
        # A nested browsing context navigating its OWN location (a[1] = the frame's
        # realm id). Deferred + applied by re-navigating the owning iframe, so a
        # frame's `location.href = …` navigates the frame, not the top page.
        '__csimFrameNavigate'        => ->(b, *a) { b.frame_navigate_self(a[0], a[1].to_i); nil },
        # A same-origin window realm (window.open in this isolate) navigating itself
        # (a[0] = url, a[1] = the window's realm id). Deferred + applied by reloading
        # that realm's document in place — see Browser#window_realm_navigate_self.
        '__csimWindowRealmNavigate'  => ->(b, *a) { b.window_realm_navigate_self(a[0], a[1].to_i); nil },
        # A nested browsing context reloading its OWN location (a[0] = the frame's
        # realm id). Deferred + applied by re-navigating the owning iframe to its
        # current document — see Browser#frame_reload_self.
        '__csimFrameReload'          => ->(b, *a) { b.frame_reload_self(a[0].to_i); nil },
        # A <form> submitted from inside a nested browsing context (a[0] = the
        # initiating frame's realm id). Deferred + applied against that realm,
        # like __csimFrameNavigate — see Browser#frame_submit_self.
        '__csimFrameSubmit'          => ->(b, *a) { b.frame_submit_self(a[0].to_i); nil },
        '__csimFrameHistoryGo'       => ->(b, *a) { b.frame_history_go(a[0].to_i, a[1].to_i); nil },
        # A frame `src=` re-navigation records a session-history entry (snapshotting the OUTGOING
        # document) so history.go(-1) can traverse back — and a controlling SW sees
        # isHistoryNavigation. Must run while the outgoing realm (a[0]) is still alive.
        '__csim_recordFrameNav'      => ->(b, *a) { b.record_frame_nav(a[0].to_i, a[1]); nil },
        '__setTimersActive'          => ->(b, *a) { b.timers_active = !!a[0]; nil },
        # a[2] is the realm that navigated: a nested browsing context keeps its OWN session
        # history, so a frame's pushState must not be mirrored onto the top document's.
        '__setCurrentUrl'            => ->(b, *a) { b.history_state(a[0], a[1], a[2]); nil },
        '__pushHistoryEntry'         => ->(b, *a) { b.history_push(a[0], a[1], a[2]); nil },
        '__historyGo'                => ->(b, *a) { b.history_go(a[0]); nil },
        '__historyLength'            => ->(b, *_) { b.history_length },
        '__csimReadFilePick'         => ->(b, *a) { b.read_file_pick(a[0], a[1], a[2], a[3]) },
        '__getDocumentCookie'        => ->(b, *_) { b.document_cookie },
        '__setDocumentCookie'        => ->(b, *a) { b.write_document_cookie(a[0].to_s); nil },
        '__getDocumentReferrer'      => ->(b, *_) { b.current_referer },
        '__csim_storageGet'          => ->(b, *a) { b.storage_get(a[0], a[1]) },
        '__csim_storageSet'          => ->(b, *a) { b.storage_set(a[0], a[1], a[2]) },
        '__csim_storageRemove'       => ->(b, *a) { b.storage_remove(a[0], a[1]); nil },
        '__csim_storageClear'        => ->(b, *a) { b.storage_clear(a[0]); nil },
        '__csim_storageKey'          => ->(b, *a) { b.storage_key(a[0], a[1]) },
        '__csim_storageLength'       => ->(b, *a) { b.storage_length(a[0]) },
        '__csimStorageChanged'       => ->(b, *a) { b.storage_changed(a[0], a[1], a[2], a[3], a[4], a[5]); nil },
        # Cache Storage — origin-partitioned (a[0] = origin key), Ruby-backed so it
        # survives the per-visit VM rebuild and is shared between a service worker and
        # the client it controls. The JS side (cache-storage.js) owns the spec matching;
        # Ruby is a dumb ordered store keyed by (origin, cache name).
        '__csim_cacheStorageOpen'    => ->(b, *a) { b.cache_storage_open(a[0], a[1]) },
        '__csim_cacheStorageHas'     => ->(b, *a) { b.cache_storage_has(a[0], a[1]) },
        '__csim_cacheStorageDelete'  => ->(b, *a) { b.cache_storage_delete(a[0], a[1]) },
        '__csim_cacheStorageKeys'    => ->(b, *a) { b.cache_storage_keys(a[0]) },
        '__csim_cacheEntries'        => ->(b, *a) { b.cache_entries(a[0], a[1]) },
        '__csim_cacheEntryResponse'  => ->(b, *a) { b.cache_entry_response(a[0], a[1], a[2]) },
        '__csim_cachePut'            => ->(b, *a) { b.cache_put(a[0], a[1], a[2], a[3], a[4]); nil },
        '__csim_cacheDeleteEntries'  => ->(b, *a) { b.cache_delete_entries(a[0], a[1], a[2]) },
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
        # Cross-window references (window.open / opener / postMessage). A separate-VM
        # aux window forwards to the Driver; a same-origin window realm lives in this
        # isolate. a[2] is the opener's realm id (for wiring window.opener); a[3]/a[4] the opener
        # document's base URL and origin, which an about:blank popup inherits.
        '__csimWindowOpen'           => ->(b, *a) { b.open_child_window(a[0], a[1], a[2], a[3], a[4]) },
        # A `target=_blank`/named link/area activation from a frame or window realm:
        # open a new auxiliary window (the realm's VM isn't rebuilt — a fresh window
        # is). `opener` = rel=opener (target=_blank defaults to noopener); the Driver
        # forces noopener for a cross-partition blob: target.
        '__csimOpenAuxFromRealm'     => ->(b, *a) { b.open_aux_from_realm(a[0], a[1], a[2]); nil },
        '__csimWindowPostMessage'    => ->(b, *a) { b.post_message_to_window(a[0], a[1], a[2], a[3]); nil },
        '__csimBroadcast'            => ->(b, *a) { b.broadcast_to_windows(a[0], a[1], a[2].to_i, a[3]); nil },
        # BroadcastChannel isolate-wide, creation-ordered registry (the multi-realm delivery path). A
        # channel registers on construction / unregisters on close; `bc_post` snapshots the eligible
        # targets at post time and queues one ordered delivery per target. Only consulted when a sibling
        # same-isolate realm exists (`bc_siblings_exist?`); single-window pages never touch it.
        '__csimBcRegister'           => ->(b, *a) { b.bc_register(a[0], a[1], a[2], a[3]); nil },
        '__csimBcUnregister'         => ->(b, *a) { b.bc_unregister(a[0], a[1]); nil },
        '__csimBcPost'               => ->(b, *a) { b.bc_post(a[0], a[1], a[2], a[3], a[4], a[5]); nil },
        '__csimBcSiblingsExist'      => ->(b, *_a) { b.bc_siblings_exist? },
        '__csimWindowGet'            => ->(b, *a) { b.window_get(a[0], a[1]) },
        '__csimWindowDocGet'         => ->(b, *a) { b.window_doc_get(a[0], a[1]) },
        # Cross-window remote-ref RPC: route an opener's node/object proxy op to
        # the target window's VM (a[0]=window handle, a[1]=ref id, a[2]=prop/method).
        '__csimWindowRefGet'         => ->(b, *a) { b.window_ref_get(a[0], a[1], a[2]) },
        '__csimWindowRefSet'         => ->(b, *a) { b.window_ref_set(a[0], a[1], a[2], a[3]); nil },
        '__csimWindowRefCall'        => ->(b, *a) { b.window_ref_call(a[0], a[1], a[2], a[3]) },
        '__csimWindowLocation'       => ->(b, *a) { b.window_location_of(a[0]) },
        '__csimWindowSetLocation'    => ->(b, *a) { b.set_window_location(a[0], a[1]); nil },
        '__csimWindowHistoryGo'      => ->(b, *a) { b.window_history_go(a[0], a[1]) },
        '__csimWindowClosed'         => ->(b, *a) { b.window_closed?(a[0]) },
        '__csimWindowClose'          => ->(b, *a) { b.close_child_window(a[0]); nil },
        '__csimWindowOpener'         => ->(b, *_) { b.opener_handle },
        # Fire an aux window's OWN `load` event (in its VM) — deferred by the
        # opener so a child `window.onload` runs after the opener's current task.
        '__csimFireAuxWindowLoad'    => ->(b, *a) { b.fire_aux_window_load(a[0]); nil },
        # a[3] is the CREATING realm (the worker dies when it is discarded); a[4] that context's
        # CURRENT controller handle, which a DEDICATED worker inherits rather than scope-matching
        # its own — often opaque (blob:/data:) — script URL. 0 when the creator is uncontrolled.
        '__csim_workerSpawn'         => ->(b, *a) { b.worker_spawn(a[0], shared: !!a[1], creator_key: a[2], realm_id: a[3].to_i, controller_handle: a[4].to_i) },
        # navigator.serviceWorker.register (universal-server only) — spawn a worker
        # running the SW script as an executor context. Returns its handle.
        '__csim_serviceWorkerRegister' => ->(b, *a) { b.worker_spawn(a[0], service: true, creator_key: a[1]) },
        '__csim_workerPostToWorker'  => ->(b, *a) { b.worker_post_to_worker(a[0], a[1]); nil },
        # ServiceWorker.postMessage from a client window → the SW's `message` event (source = client).
        '__csim_serviceWorkerPostMessage' => ->(b, *a) { b.service_worker_post_message(a[0], a[1], a[2], a[3]); nil },
        # Cross-isolate MessagePort channel (client-realm side): register this realm's endpoint, and
        # relay a client-realm port's postMessage to its remote (worker/SW) peer.
        '__csimClientPortEndpoint' => ->(b, *a) { b.port_channel_endpoint_realm(a[0], a[1]); nil },
        '__csimClientPortPost'     => ->(b, *a) { b.client_port_post(a[0], a[1]); nil },
        # The focus chain moved into this realm's browsing context (a focus() commit, or an
        # <iframe> focused in its container, which hands focus to the nested context).
        '__csimNoteFocusedRealm'   => ->(b, *a) { b.note_focused_realm(a[0]); nil },
        # This realm is a service-worker client: reported at document load and again whenever
        # control is installed, by the realm, because only it knows its own URL, frame type and
        # controller. `a[3]` is the controlling worker's handle, 0 when uncontrolled.
        '__csimNoteClient' => ->(b, *a) { b.sw_note_client(a[0], a[1], a[2], a[3]); nil },
        # A controlled client's fetch → the controlling SW's `fetch` event. Returns false if the SW
        # is gone (client falls back to the network).
        '__csim_serviceWorkerControllerFetch' => ->(b, *a) { b.service_worker_controller_fetch(a[0], a[1], a[2], a[3]) },
        # A controlled client cancelled a streaming respondWith body → cancel the SW's source stream
        # (routed to the worker that owns this [realm, fetch] stream). See sw_stream_cancel.
        '__csim_swStreamCancel'               => ->(b, *a) { b.sw_stream_cancel(a[0], a[1]); nil },
        # Client lifecycle mirrors scope→active-worker into Ruby so a navigation (fetched
        # Ruby-side before the destination realm's JS exists) can find its controlling SW.
        '__csim_swRegisterScope'      => ->(b, *a) { b.sw_register_scope(a[0], a[1]); nil },
        '__csim_swUnregisterScope'    => ->(b, *a) { b.sw_unregister_scope(a[0]); nil },
        # The active worker handle at an EXACT scope (0 if none), so a register() from a realm with no
        # local registration (a different iframe registering an already-active scope) can synthesize a
        # registration reflecting the shared active worker instead of installing a duplicate.
        '__csim_swActiveHandleForScope' => ->(b, *a) { b.sw_active_handle_for_scope(a[0]) },
        # Does this worker still control any client? An incoming worker may only activate once the
        # outgoing one controls nothing (or skipWaiting is called) — see _scheduleLifecycle.
        '__csim_swControlsClients'    => ->(b, *a) { b.sw_worker_controls_clients?(a[0]) },
        '__csim_swNoteActivationParked' => ->(b, *_) { b.sw_note_activation_parked; nil },
        # Navigation Preload state (NavigationPreloadManager), keyed by the registration's active
        # worker handle — reached identically from the client (registration.active._handle) and the
        # worker (__csimWorkerHandle). Get returns {enabled, headerValue}; set leaves a nil field as-is.
        '__csim_swNavPreloadState'    => ->(b, *a) { b.nav_preload_state(a[0]) },
        '__csim_swNavPreloadSet'      => ->(b, *a) { b.nav_preload_set(a[0], a[1], a[2]); nil },
        # A navigation (iframe/document load) → its controlling SW's `fetch` event, awaited
        # synchronously. Returns the response wire hash, or nil to load from the network.
        '__csim_swNavigationFetch'    => ->(b, *a) { b.service_worker_navigation_fetch(a[0], is_reload: !!a[1], is_history: !!a[2], referrer_source: a[3], method: a[4] || 'GET', body_b64: a[5] || '', content_type: a[6]) },
        '__csim_workerTerminate'     => ->(b, *a) { b.worker_terminate(a[0]); nil },
        '__csim_decodeImage'         => ->(b, *a) { b.decode_image(a[0], a[1], a[2]) },
        '__csim_renderText'          => ->(b, *a) { b.render_text(a[0], a[1], a[2], a[3], a[4]) },
        '__csim_loadImage'           => ->(b, *a) { b.load_image(a[0], !!a[1], a[2] || 'same-origin') },
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
        '__csim_videoBytesB64'       => ->(b, *a) { b.video_bytes_b64(a[0]) },
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
      # Process-wide PER-SHEET parse cache (the CSS analogue of the JS bytecode
      # cache). `parseSheet` is pure, so the JS side caches its serialized
      # `{hide,layout}` here keyed by (cssText hash, viewport), surviving the
      # per-visit VM rebuild that wipes the in-VM `__sheetCache`. A cascade
      # rebuild then re-parses only sheets it has never seen (content change =
      # new key). Content-keyed ONLY — never url-keyed — so freshness stays the
      # asset cache's call. Capped.
      SHEET_PARSE_CACHE       = {}
      SHEET_PARSE_CACHE_MUTEX = Mutex.new
      SHEET_PARSE_CACHE_MAX   = 2048

      STDLIB_HOST_FNS = {
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
        # Web Crypto raw primitives, backed by OpenSSL. The JS side (js/src/webcrypto.js)
        # owns the whole SubtleCrypto contract — algorithm normalization, CryptoKey
        # objects, usage validation, the DOMException grammar — and calls these only for
        # the actual number-crunching. Byte arguments cross as plain Arrays (JS packs a
        # BufferSource into one); results return as byte Arrays.
        #
        # digest — algo is "SHA1"/"SHA256"/… (JS strips the dash and upcases).
        '__csim_subtleDigest' => lambda {|*a|
          algo  = a[0].to_s.upcase.tr('-', '')
          bytes = a[1].is_a?(Array) ? a[1].pack('C*') : a[1].to_s
          OpenSSL::Digest.new(algo).digest(bytes).bytes
        },
        # HMAC sign — args: (hash "SHA256", keyBytes, dataBytes) → mac bytes. verify is
        # done JS-side by re-signing and comparing, so no separate host fn is needed.
        '__csim_hmacSign' => lambda {|*a|
          hash = a[0].to_s.upcase.tr('-', '')
          key  = a[1].is_a?(Array) ? a[1].pack('C*') : a[1].to_s
          data = a[2].is_a?(Array) ? a[2].pack('C*') : a[2].to_s
          OpenSSL::HMAC.digest(OpenSSL::Digest.new(hash), key, data).bytes
        },
        # AES encrypt/decrypt — args: (cipher "aes-256-gcm", key, iv, data, aad, tagBytes).
        # For GCM the JS side follows the WebCrypto layout (ciphertext ‖ truncated tag), so
        # encrypt appends the tagBytes-long tag and decrypt splits it back off before
        # verifying; a tag mismatch / bad padding raises CipherError, which the JS layer
        # maps to OperationError. CBC/CTR pass tagBytes 0 and an empty aad.
        '__csim_aesEncrypt' => lambda {|*a|
          name = a[0].to_s
          key  = a[1].is_a?(Array) ? a[1].pack('C*') : a[1].to_s
          iv   = a[2].is_a?(Array) ? a[2].pack('C*') : a[2].to_s
          data = a[3].is_a?(Array) ? a[3].pack('C*') : a[3].to_s
          aad  = a[4].is_a?(Array) ? a[4].pack('C*') : a[4].to_s
          tagbytes = a[5].to_i
          c = OpenSSL::Cipher.new(name)
          c.encrypt
          c.key = key
          c.iv_len = iv.bytesize if name.end_with?('-gcm')   # GCM defaults to 12; allow any length
          c.iv  = iv
          if name.end_with?('-gcm')
            c.auth_data = aad
            ct = c.update(data) + c.final
            (ct + c.auth_tag(tagbytes)).bytes
          else
            (c.update(data) + c.final).bytes
          end
        },
        '__csim_aesDecrypt' => lambda {|*a|
          name = a[0].to_s
          key  = a[1].is_a?(Array) ? a[1].pack('C*') : a[1].to_s
          iv   = a[2].is_a?(Array) ? a[2].pack('C*') : a[2].to_s
          data = a[3].is_a?(Array) ? a[3].pack('C*') : a[3].to_s
          aad  = a[4].is_a?(Array) ? a[4].pack('C*') : a[4].to_s
          tagbytes = a[5].to_i
          c = OpenSSL::Cipher.new(name)
          c.decrypt
          c.key = key
          c.iv_len = iv.bytesize if name.end_with?('-gcm')
          c.iv  = iv
          if name.end_with?('-gcm')
            ct  = data[0, data.bytesize - tagbytes]
            tag = data[data.bytesize - tagbytes, tagbytes]
            c.auth_data = aad
            c.auth_tag  = tag
            (c.update(ct) + c.final).bytes
          else
            (c.update(data) + c.final).bytes
          end
        },
        # RSA — keys cross as their DER encoding (SPKI for public, PKCS#8 for private)
        # in a byte Array; the host re-parses per call (OpenSSL::PKey.read auto-detects).
        # generateKey returns the private PKCS#8 DER, from which the JS side derives the
        # public key and parameters via the export / key-info fns below.
        '__csim_rsaGenerate' => lambda {|*a|
          bits = a[0].to_i
          exp  = OpenSSL::BN.new(crypto_bytes(a[1]), 2).to_i
          OpenSSL::PKey::RSA.generate(bits, exp).private_to_der.bytes
        },
        # Re-encode a key to 'spki' (public) or 'pkcs8' (private). Asking a private key
        # for 'spki' yields its public half — how generateKey obtains the public key.
        '__csim_rsaExport' => lambda {|*a|
          key = RuntimeShared.pkey_read(a[0])
          a[1].to_s == 'spki' ? key.public_to_der.bytes : key.private_to_der.bytes
        },
        # Modulus length (bits) + public exponent (big-endian bytes) for key.algorithm.
        '__csim_rsaKeyInfo' => lambda {|*a|
          key = RuntimeShared.pkey_read(a[0])
          { 'modulusLength' => key.n.num_bits, 'publicExponent' => key.e.to_s(2).bytes }
        },
        # Build a key DER from JWK components (big-endian byte arrays). Public keys pass
        # only n/e; private keys pass the full CRT set. Returns SPKI / PKCS#8 DER bytes.
        '__csim_rsaImportJwk' => lambda {|*a|
          RuntimeShared.rsa_jwk_to_der(*a).bytes
        },
        # Explode a key DER into JWK components (big-endian byte arrays). Private keys
        # include the CRT parameters; public keys carry only n/e.
        '__csim_rsaExportJwk' => lambda {|*a|
          RuntimeShared.rsa_der_to_jwk(a[0])
        },
        # sign/verify — scheme 'pkcs1' (RSASSA-PKCS1-v1_5) or 'pss' (RSA-PSS, MGF1 with
        # the same hash, saltLength in bytes). verify swallows OpenSSL errors to a false.
        '__csim_rsaSign' => lambda {|*a|
          key  = RuntimeShared.pkey_read(a[0])
          hash = a[1].to_s
          data = crypto_bytes(a[2])
          if a[3].to_s == 'pss'
            key.sign_pss(hash, data, salt_length: a[4].to_i, mgf1_hash: hash).bytes
          else
            key.sign(hash, data).bytes
          end
        },
        '__csim_rsaVerify' => lambda {|*a|
          key  = RuntimeShared.pkey_read(a[0])
          hash = a[1].to_s
          data = crypto_bytes(a[2])
          sig  = crypto_bytes(a[3])
          begin
            if a[4].to_s == 'pss'
              key.verify_pss(hash, sig, data, salt_length: a[5].to_i, mgf1_hash: hash)
            else
              key.verify(hash, sig, data)
            end
          rescue OpenSSL::PKey::PKeyError
            false
          end
        },
        # RSA-OAEP encrypt/decrypt — MGF1 + OAEP with the key's hash and an optional label.
        # `rsa_oaep_label` takes a HEX string, not raw bytes (OpenSSL parses it via
        # prepare_from_text), so the label crosses hex-encoded.
        '__csim_rsaEncrypt' => lambda {|*a|
          key   = RuntimeShared.pkey_read(a[0])
          opts  = { rsa_padding_mode: 'oaep', rsa_oaep_md: a[1].to_s }
          label = crypto_bytes(a[3])
          opts[:rsa_oaep_label] = label.unpack1('H*') unless label.empty?
          key.encrypt(crypto_bytes(a[2]), opts).bytes
        },
        '__csim_rsaDecrypt' => lambda {|*a|
          key   = RuntimeShared.pkey_read(a[0])
          opts  = { rsa_padding_mode: 'oaep', rsa_oaep_md: a[1].to_s }
          label = crypto_bytes(a[3])
          opts[:rsa_oaep_label] = label.unpack1('H*') unless label.empty?
          key.decrypt(crypto_bytes(a[2]), opts).bytes
        },
        # Elliptic curve (ECDSA / ECDH). The JS side passes the OpenSSL curve name
        # ('prime256v1' / 'secp384r1' / 'secp521r1') and the field byte length so the
        # host stays curve-agnostic. Keys cross as SPKI / PKCS#8 DER.
        '__csim_ecGenerate' => lambda {|*a|
          OpenSSL::PKey::EC.generate(a[0].to_s).private_to_der.bytes
        },
        '__csim_ecExport' => lambda {|*a|
          key = RuntimeShared.pkey_read(a[0])
          case a[1].to_s
          when 'spki'  then key.public_to_der.bytes
          when 'pkcs8' then key.private_to_der.bytes
          else key.public_key.to_octet_string(:uncompressed).bytes   # 'raw' → uncompressed point
          end
        },
        '__csim_ecKeyInfo' => lambda {|*a|
          { 'curve' => RuntimeShared.pkey_read(a[0]).group.curve_name }
        },
        '__csim_ecImportRaw' => lambda {|*a|
          RuntimeShared.ec_point_spki(a[0].to_s, crypto_bytes(a[1])).bytes
        },
        # args: (curve, isPrivate, x, y, [d, n]). The uncompressed public point is
        # 0x04 ‖ x ‖ y; a private key additionally carries the scalar d (padded to n).
        '__csim_ecImportJwk' => lambda {|*a|
          curve = a[0].to_s
          point = "\x04".b + crypto_bytes(a[2]) + crypto_bytes(a[3])
          if a[1]
            RuntimeShared.ec_priv_pkcs8(curve, crypto_bytes(a[4]), point, a[5].to_i).bytes
          else
            RuntimeShared.ec_point_spki(curve, point).bytes
          end
        },
        '__csim_ecExportJwk' => lambda {|*a|
          RuntimeShared.ec_der_to_jwk(a[0], a[1].to_i)
        },
        '__csim_ecdsaSign' => lambda {|*a|
          key = RuntimeShared.pkey_read(a[0])
          der = key.sign(OpenSSL::Digest.new(a[1].to_s), crypto_bytes(a[2]))
          RuntimeShared.ecdsa_der_to_raw(der, a[3].to_i).bytes
        },
        '__csim_ecdsaVerify' => lambda {|*a|
          key = RuntimeShared.pkey_read(a[0])
          der = RuntimeShared.ecdsa_raw_to_der(crypto_bytes(a[3]), a[4].to_i)
          begin
            der ? key.verify(OpenSSL::Digest.new(a[1].to_s), der, crypto_bytes(a[2])) : false
          rescue OpenSSL::PKey::PKeyError
            false
          end
        },
        # Key derivation — HKDF / PBKDF2 produce `nbytes` bytes; ECDH computes the raw
        # shared secret (field size). The JS side truncates to the requested bit length.
        '__csim_hkdf' => lambda {|*a|
          OpenSSL::KDF.hkdf(crypto_bytes(a[1]), salt: crypto_bytes(a[2]), info: crypto_bytes(a[3]), length: a[4].to_i, hash: a[0].to_s).bytes
        },
        '__csim_pbkdf2' => lambda {|*a|
          OpenSSL::KDF.pbkdf2_hmac(crypto_bytes(a[1]), salt: crypto_bytes(a[2]), iterations: a[3].to_i, length: a[4].to_i, hash: a[0].to_s).bytes
        },
        '__csim_ecdhDerive' => lambda {|*a|
          priv = RuntimeShared.pkey_read(a[0])
          pub  = RuntimeShared.pkey_read(a[1])
          priv.dh_compute_key(pub.public_key).bytes
        },
        # AES-KW (RFC 3394 key wrap). The cipher width follows the wrapping key; OpenSSL's
        # wrap mode supplies the default A6A6… IV. A tampered wrap raises on unwrap, which
        # the JS layer maps to OperationError.
        '__csim_aesKwWrap' => lambda {|*a|
          key = crypto_bytes(a[0])
          c = OpenSSL::Cipher.new("aes-#{key.bytesize * 8}-wrap")
          c.encrypt
          c.key = key
          (c.update(crypto_bytes(a[1])) + c.final).bytes
        },
        '__csim_aesKwUnwrap' => lambda {|*a|
          key = crypto_bytes(a[0])
          c = OpenSSL::Cipher.new("aes-#{key.bytesize * 8}-wrap")
          c.decrypt
          c.key = key
          (c.update(crypto_bytes(a[1])) + c.final).bytes
        },
        # OKP curves (Ed25519 signatures / X25519 key agreement). The JS side passes the
        # OpenSSL curve name ('ED25519' / 'X25519'); keys cross as SPKI / PKCS#8 DER, and
        # the raw form is the 32-byte public (or private, via JWK `d`) key.
        '__csim_okpGenerate' => lambda {|*a|
          OpenSSL::PKey.generate_key(a[0].to_s).private_to_der.bytes
        },
        '__csim_okpExport' => lambda {|*a|
          key = RuntimeShared.pkey_read(a[0])
          case a[1].to_s
          when 'spki'  then key.public_to_der.bytes
          when 'pkcs8' then key.private_to_der.bytes
          else key.raw_public_key.bytes                     # 'raw' → 32-byte public key
          end
        },
        '__csim_okpImportRaw' => lambda {|*a|
          OpenSSL::PKey.new_raw_public_key(a[0].to_s, crypto_bytes(a[1])).public_to_der.bytes
        },
        # Parse + re-emit a canonical OKP DER — validates the SPKI/PKCS#8 structure at
        # import time (a truncated / malformed key raises, which JS maps to DataError)
        # instead of storing the bytes blindly and only failing on first use.
        '__csim_okpImportDer' => lambda {|*a|
          key = RuntimeShared.pkey_read(a[1])
          a[0].to_s == 'private' ? key.private_to_der.bytes : key.public_to_der.bytes
        },
        '__csim_okpImportJwk' => lambda {|*a|
          type = a[0].to_s
          if a[1]
            key = OpenSSL::PKey.new_raw_private_key(type, crypto_bytes(a[3]))
            # The JWK "x" (public) must equal the public key derived from "d" — a mismatch is
            # an invalid key pair (DataError on the JS side).
            raise OpenSSL::PKey::PKeyError, 'OKP JWK x does not match d' unless key.raw_public_key == crypto_bytes(a[2])
            key.private_to_der.bytes
          else
            OpenSSL::PKey.new_raw_public_key(type, crypto_bytes(a[2])).public_to_der.bytes
          end
        },
        '__csim_okpExportJwk' => lambda {|*a|
          key = RuntimeShared.pkey_read(a[0])
          jwk = { 'x' => key.raw_public_key.bytes }
          jwk['d'] = key.raw_private_key.bytes if a[1]      # a[1] = the key is private
          jwk
        },
        '__csim_ed25519Sign' => lambda {|*a|
          RuntimeShared.pkey_read(a[0]).sign(nil, crypto_bytes(a[1])).bytes
        },
        '__csim_ed25519Verify' => lambda {|*a|
          key = RuntimeShared.pkey_read(a[0])
          begin
            key.verify(nil, crypto_bytes(a[2]), crypto_bytes(a[1]))
          rescue OpenSSL::PKey::PKeyError
            false
          end
        },
        '__csim_x25519Derive' => lambda {|*a|
          RuntimeShared.pkey_read(a[0]).derive(RuntimeShared.pkey_read(a[1])).bytes
        }
      }.freeze

      # Pack a host-fn byte argument (a JS BufferSource crosses as an Array) into a
      # binary String for OpenSSL.
      def self.crypto_bytes(a)
        a.is_a?(Array) ? a.pack('C*') : a.to_s
      end

      # Parse an RSA / EC key from its DER bytes (SPKI public or PKCS#8 private —
      # OpenSSL::PKey.read auto-detects both).
      def self.pkey_read(der_bytes)
        OpenSSL::PKey.read(crypto_bytes(der_bytes))
      end

      # ECDSA signatures cross as the WebCrypto IEEE-P1363 form — r ‖ s, each padded to
      # the curve's field byte length — while OpenSSL speaks DER. Convert both ways.
      def self.ecdsa_der_to_raw(der, n)
        asn = OpenSSL::ASN1.decode(der)
        r = asn.value[0].value.to_s(2).rjust(n, "\x00".b)
        s = asn.value[1].value.to_s(2).rjust(n, "\x00".b)
        r + s
      end

      def self.ecdsa_raw_to_der(raw, n)
        return nil unless raw.bytesize == 2 * n   # wrong length → verify fails, not raises
        r = OpenSSL::BN.new(raw[0, n], 2)
        s = OpenSSL::BN.new(raw[n, n], 2)
        OpenSSL::ASN1::Sequence([OpenSSL::ASN1::Integer(r), OpenSSL::ASN1::Integer(s)]).to_der
      end

      def self.ec_algid(curve)
        OpenSSL::ASN1::Sequence([OpenSSL::ASN1::ObjectId('id-ecPublicKey'), OpenSSL::ASN1::ObjectId(curve)])
      end

      # SPKI DER for an EC public key from its uncompressed point (0x04 ‖ x ‖ y).
      def self.ec_point_spki(curve, point)
        OpenSSL::ASN1::Sequence([ec_algid(curve), OpenSSL::ASN1::BitString(point)]).to_der
      end

      # PKCS#8 DER for an EC private key from the private scalar `d` and public point,
      # via the RFC 5915 ECPrivateKey structure (OpenSSL 3 dropped component setters).
      def self.ec_priv_pkcs8(curve, d, point, n)
        ec_priv = OpenSSL::ASN1::Sequence([
          OpenSSL::ASN1::Integer(1),
          OpenSSL::ASN1::OctetString(d.rjust(n, "\x00".b)),
          OpenSSL::ASN1::ASN1Data.new([OpenSSL::ASN1::ObjectId(curve)], 0, :CONTEXT_SPECIFIC),
          OpenSSL::ASN1::ASN1Data.new([OpenSSL::ASN1::BitString(point)], 1, :CONTEXT_SPECIFIC)
        ]).to_der
        OpenSSL::ASN1::Sequence([OpenSSL::ASN1::Integer(0), ec_algid(curve), OpenSSL::ASN1::OctetString(ec_priv)]).to_der
      end

      # Explode an EC key DER into JWK coordinates (x, y, and d for a private key), each a
      # big-endian byte Array padded to the field length; plus the OpenSSL curve name.
      def self.ec_der_to_jwk(der_bytes, n)
        key   = pkey_read(der_bytes)
        point = key.public_key.to_octet_string(:uncompressed)   # 0x04 ‖ x ‖ y
        jwk   = { 'curve' => key.group.curve_name, 'x' => point[1, n].bytes, 'y' => point[1 + n, n].bytes }
        jwk['d'] = key.private_key.to_s(2).rjust(n, "\x00".b).bytes if key.private_key?
        jwk
      end

      # Assemble an RSA key DER from JWK components. `is_private` selects between a
      # public SPKI (n, e) and a private PKCS#8 with the full CRT set. Each component is
      # a big-endian byte Array. Building the ASN.1 by hand is the OpenSSL-3-supported
      # path (the deprecated `rsa.n = …` setters are gone).
      def self.rsa_jwk_to_der(is_private, n, e, d = nil, p = nil, q = nil, dp = nil, dq = nil, qi = nil)
        bn     = ->(b) { OpenSSL::BN.new(crypto_bytes(b), 2) }
        alg_id = OpenSSL::ASN1::Sequence([OpenSSL::ASN1::ObjectId('rsaEncryption'), OpenSSL::ASN1::Null(nil)])
        if is_private
          pkcs1 = OpenSSL::ASN1::Sequence([
            OpenSSL::ASN1::Integer(0),
            OpenSSL::ASN1::Integer(bn.(n)), OpenSSL::ASN1::Integer(bn.(e)), OpenSSL::ASN1::Integer(bn.(d)),
            OpenSSL::ASN1::Integer(bn.(p)), OpenSSL::ASN1::Integer(bn.(q)),
            OpenSSL::ASN1::Integer(bn.(dp)), OpenSSL::ASN1::Integer(bn.(dq)), OpenSSL::ASN1::Integer(bn.(qi))
          ]).to_der
          OpenSSL::ASN1::Sequence([OpenSSL::ASN1::Integer(0), alg_id, OpenSSL::ASN1::OctetString(pkcs1)]).to_der
        else
          pkcs1 = OpenSSL::ASN1::Sequence([OpenSSL::ASN1::Integer(bn.(n)), OpenSSL::ASN1::Integer(bn.(e))]).to_der
          OpenSSL::ASN1::Sequence([alg_id, OpenSSL::ASN1::BitString(pkcs1)]).to_der
        end
      end

      # Explode an RSA key DER into JWK components (big-endian byte Arrays). Private keys
      # carry the full CRT set; public keys only n/e.
      def self.rsa_der_to_jwk(der_bytes)
        key = pkey_read(der_bytes)
        jwk = { 'n' => key.n.to_s(2).bytes, 'e' => key.e.to_s(2).bytes }
        if key.private?
          jwk.merge!(
            'd'  => key.d.to_s(2).bytes,   'p'  => key.p.to_s(2).bytes,   'q'  => key.q.to_s(2).bytes,
            'dp' => key.dmp1.to_s(2).bytes, 'dq' => key.dmq1.to_s(2).bytes, 'qi' => key.iqmp.to_s(2).bytes
          )
        end
        jwk
      end

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
