# frozen_string_literal: true

require_relative 'webauthn_state'


module Capybara
  module Simulated
    # The engine-facing constants and tables — JS asset paths, the
    # host-fn table that bridge.js reaches back through, the
    # error-swallowing wrapper. `V8Runtime` plugs the table into
    # rusty_racer's `Context#attach` for the main realm and every
    # worker isolate alike.
    module RuntimeShared
      BRIDGE_JS         = File.expand_path('js/bridge.bundle.js',                 __dir__).freeze
      SNAPSHOT_STUBS_JS = File.expand_path('js/snapshot_stubs.js',                __dir__).freeze
      VENDOR_BUNDLE_JS  = File.expand_path('../../../vendor/js/vendor.bundle.js', __dir__).freeze

      def self.snapshot_stubs_src = File.read(SNAPSHOT_STUBS_JS)
      def self.bridge_src         = File.read(BRIDGE_JS)
      def self.vendor_bundle_src  = File.read(VENDOR_BUNDLE_JS)

      # Combined source baked into the V8 Snapshot.
      # Order matters: stubs first (so bridge's IIFE can reference the
      # `globalThis.__rackFetch` etc. slots), then the vendor bundle
      # (so bridge can reference `globalThis.__csimVendor.cssTree`), then
      # bridge proper.
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
        '__rackFetch'                => ->(b, *a) { b.rack_fetch(a[0], a[1], a[2], a[3], a[4], a[5], credentials: a[6] || 'same-origin', referrer_policy: a[7], referrer: a[8], cache_mode: a[9] || 'default', initiator: a[10], site_seed: a[11], origin_null: a[12], client_url: a[13], cookie_cross_site: a[14] == true, nav_dest: a[15], client_origin: a[16], client_realm: a[17], navigation: a[18] == true) },
        '__csimExternalAsset'        => ->(b, *a) { b.external_asset_source(a[0], a[1], a[2], a[3]) },
        '__csimSubresourceFetch'     => ->(b, *a) { b.subresource_fetch(a[0], a[1].to_i, a[2]) },
        '__csimAssetDocumentStarted' => ->(b, *_a) { b.asset_document_started },
        '__csimExternalAssetMeta'    => ->(b, *a) { b.external_asset_meta(a[0]) },
        '__csimExternalAssetBytes'   => ->(b, *a) { b.external_asset_bytes(a[0]) },
        # fetch(…, {keepalive}) — eager detached-thread dispatch + one-shot result poll.
        '__csim_keepaliveStart'      => ->(b, *a) { b.keepalive_start(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11]) },
        '__csim_keepaliveTake'       => ->(b, *a) { b.keepalive_take(a[0]) },
        # A controlled document's external classic script → its controller's fetch
        # event, synchronously (destination 'script'). See sw_script_subresource_fetch.
        '__csim_swScriptFetch'       => ->(b, *a) { b.sw_script_subresource_fetch(a[0], a[1], a[2], a[3], a[4] || 'script', a[5] || 'no-cors', a[6] || 'include', binary: a[7] == true, integrity: a[8] || '') },
        '__locationAssign'           => ->(b, *a) { b.location_assign(a[0], replace: a[1] == true, initiator_realm: a[2], policy: a[3].to_s); nil },
        '__locationReload'           => ->(b, *_) { b.location_reload; nil },
        '__csimCancelPlannedNavigation' => ->(b, *_) { b.cancel_planned_navigation; nil },
        # A nested browsing context navigated (a[1] = the frame's realm id) — its OWN
        # location, or (a[3] = the initiating realm id) a link whose target names it,
        # under the policy (a[4]) its `rel` / `referrerpolicy` sets.
        # Deferred + applied by re-navigating the owning iframe, so a frame's
        # `location.href = …` navigates the frame, not the top page.
        '__csimFrameNavigate'        => ->(b, *a) { b.frame_navigate_self(a[0], a[1].to_i, a[3].nil? ? a[1].to_i : a[3].to_i, a[4].to_s, replace: a[2] == true); nil },
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
        '__csimFrameSubmit'          => ->(b, *a) { b.frame_submit_self(a[0].to_i, a[1].to_s, a[2]) == true },
        # A frame `src=` re-navigation records a session-history entry (snapshotting the OUTGOING
        # document) so history.go(-1) can traverse back — and a controlling SW sees
        # isHistoryNavigation. Must run while the outgoing realm (a[0]) is still alive.
        '__csim_recordFrameNav'      => ->(b, *a) { b.record_frame_nav(a[0].to_i, a[1], post: a[2] && {body: RuntimeShared.latin1_bytes(a[2]), content_type: a[3].to_s}); nil },
        # …and the outgoing document unloaded (a[0] its realm, alive still): the entry takes its form state as its
        # pagehide / unload handlers left it.
        '__csim_frameUnloaded'       => ->(b, *a) { b.frame_document_unloaded(a[0].to_i); nil },
        '__setTimersActive'          => ->(b, *a) { b.timers_active = !!a[0]; nil },
        # a[2] is the realm that navigated: a nested browsing context keeps its OWN session
        # history, so a frame's pushState must not be mirrored onto the top document's.
        '__setCurrentUrl'            => ->(b, *a) { b.history_state(a[0], a[1], a[2]); nil },
        '__pushHistoryEntry'         => ->(b, *a) { b.history_push(a[0], a[1], a[2]); nil },
        '__historyGo'                => ->(b, *a) { b.plan_history_traverse(a[0], a[1]) },
        '__csimApplyTraversal'       => ->(b, *a) { b.apply_planned_traversal(a[0].to_i); nil },
        '__csimSupersedeFrameNavigation' => ->(b, *a) { b.frame_navigation_superseded(a[0].to_i); nil },
        '__historyLength'            => ->(b, *a) { b.history_length(a[0].to_i) },
        '__csimReadFilePick'         => ->(b, *a) { b.read_file_pick(a[0], a[1], a[2], a[3]) },
        '__getDocumentCookie'        => ->(b, *a) { b.document_cookie(a[0], a[1]) },
        '__setDocumentCookie'        => ->(b, *a) { b.write_document_cookie(a[0].to_s, a[1], a[2]); nil },
        '__csimDeleteAllCookies'     => ->(b, *_) { b.delete_all_cookies; nil },
        '__csimStoragePartitions'    => ->(b, *_a) { b.storage_partitions },
        '__csimStorageChanged'       => ->(b, *a) { b.storage_changed(*a[0, 7]); nil },
        '__csimGeolocationState'     => ->(b, *_) { b.geolocation_state_json },
        '__modalDialog'              => ->(b, *a) { b.handle_modal(a[0], a[1], a[2]) },
        '__csim_pushImportmap'       => ->(b, *a) { b.set_importmap(a[0], a[1]); nil },
        '__csim_logConsole'          => ->(b, *a) { b.log_console(a[0], a[1]); nil },
        '__csim_eventSourceOpen'     => ->(b, *a) { b.event_source_open(a[0]) },
        '__csim_eventSourceClose'    => ->(b, *a) { b.event_source_close(a[0]); nil },
        '__csim_wsOpen'              => ->(b, *a) { b.ws_open(a[0], a[1]) },
        '__csim_wsSend'              => ->(b, *a) { b.ws_send(a[0], a[1], a[2]); nil },
        '__csim_wsClose'             => ->(b, *a) { b.ws_close(a[0], a[1], a[2]); nil },
        '__csim_rackFetchAsync'      => ->(b, *a) { b.rack_fetch_async(a[0], a[1], a[2], a[3], credentials: a[4] || 'same-origin', client_url: a[5], client_origin: a[6], client_realm: a[7], referrer_policy: a[8]) },
        '__csim_rackFetchAsyncAbort' => ->(b, *a) { b.rack_fetch_async_abort(a[0]); nil },
        # Cross-window references (window.open / opener / postMessage). A separate-VM
        # aux window forwards to the Driver; a same-origin window realm lives in this
        # isolate. a[2] is the opener's realm id (for wiring window.opener); a[3]/a[4] the opener
        # document's base URL and origin, which an about:blank popup inherits.
        '__csimWindowOpen'           => ->(b, *a) { b.open_child_window(a[0], a[1], a[2], a[3], a[4], a[5], a[6]) },
        # A `target=_blank`/named link/area activation from a frame or window realm:
        # open a new auxiliary window (the realm's VM isn't rebuilt — a fresh window
        # is). `opener` = rel=opener (target=_blank defaults to noopener); the Driver
        # forces noopener for a cross-partition blob: target.
        '__csimOpenAuxFromRealm'     => ->(b, *a) { b.open_aux_from_realm(*a[0, 6]); nil },
        '__csimWindowPostMessage'    => ->(b, *a) { b.post_message_to_window(a[0], a[1], a[2], a[3]); nil },
        '__csimBroadcast'            => ->(b, *a) { b.broadcast_to_windows(a[0], a[1], a[2].to_i, a[3]); nil },
        # BroadcastChannel's isolate-wide, creation-ordered delivery (the multi-realm path): `bc_post` queues one ordered
        # delivery per channel the isolate's registry (broadcast_channels.rs) snapshot at post time. Only taken where a
        # sibling same-isolate realm exists (`bc_siblings_exist?`); single-window pages never touch it.
        '__csimBcPost'               => ->(b, *a) { b.bc_post(a[0], a[1], a[2], a[3], a[4]); nil },
        '__csimBcSiblingsExist'      => ->(b, *_a) { b.bc_siblings_exist? },
        # The session's partition of the storage registries — IndexedDB's, which every realm and worker of it is an agent
        # of, and Cache Storage's (idb_databases.rs, cache_storage.rs).
        '__csimSessionPartition'     => ->(b, *_a) { b.session_partition },
        # …and the space the window's environment ids are minted in (Browser#client_space).
        '__csimClientSpace'          => ->(b, *_a) { b.client_space },
        '__csimWindowGet'            => ->(b, *a) { b.window_get(a[0], a[1]) },
        '__csimWindowDocGet'         => ->(b, *a) { b.window_doc_get(a[0], a[1]) },
        # Cross-window remote-ref RPC: route an opener's node/object proxy op to
        # the target window's VM (a[0]=window handle, a[1]=ref id, a[2]=prop/method).
        '__csimWindowRefGet'         => ->(b, *a) { b.window_ref_get(a[0], a[1], a[2]) },
        '__csimWindowRefSet'         => ->(b, *a) { b.window_ref_set(a[0], a[1], a[2], a[3]); nil },
        '__csimWindowRefCall'        => ->(b, *a) { b.window_ref_call(a[0], a[1], a[2], a[3]) },
        '__csimWindowLocation'       => ->(b, *a) { b.window_location_of(a[0]) },
        '__csimWindowSetLocation'    => ->(b, *a) { b.set_window_location(a[0], a[1]); nil },
        '__csimWindowJavascriptURL'  => ->(b, *a) { b.run_window_javascript_url(a[0], a[1], a[2]); nil },
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
        '__csim_workerSpawn'         => ->(b, *a) { b.worker_spawn(a[0], shared: !!a[1], creator_key: a[2], realm_id: a[3].to_i, controller_handle: a[4].to_i, script_type: a[5], name: a[6].to_s) },
        # A register(), update() or unregister(), scheduled as a job at its scope (see sw_schedule_job), and the job run, the task
        # queued for it — and the registration's updateViaCache mode, REGISTRATION-wide state (a frame's
        # registration object must see the mode the top window set).
        '__csim_swScheduleJob'         => ->(b, *a) { b.sw_schedule_job(*a.first(10)) },
        '__csim_swRunJob'              => ->(b, *a) { b.sw_run_job(a[0]); nil },
        '__csim_swScopeUpdateViaCache' => ->(b, *a) { b.sw_scope_update_via_cache(a[0]) },
        '__csim_swNoteImport'          => ->(b, *a) { b.sw_note_import(a[0].to_i, a[1], a[2]) },
        '__csim_workerPostToWorker'  => ->(b, *a) { b.worker_post_to_worker(a[0], a[1]); nil },
        # ServiceWorker.postMessage from a client window → the SW's `message` event (source = client).
        '__csim_serviceWorkerPostMessage' => ->(b, *a) { b.service_worker_post_message(a[0], a[1], a[2], a[3]); nil },
        # Cross-isolate MessagePort channels (a window or frame realm's side): the ends its ports take and give up, and
        # what they post.
        '__csimClientPortEndHere'  => ->(b, *a) { b.port_end_here(a[0], [:realm, a[1].to_i]); nil },
        '__csimClientPortEndGone'  => ->(b, *a) { b.port_end_gone(a[0], a[1], [:realm, a[2].to_i]); nil },
        '__csimClientPortEndClosed' => ->(b, *a) { b.port_end_closed(a[0]); nil },
        '__csimClientPortRedeliver' => ->(b, *a) { b.port_redeliver(a[0], a[1]); nil },
        '__csimClientPortPost'     => ->(b, *a) { b.port_post(a[0], a[1]); nil },
        # The focus chain moved into this realm's browsing context (a focus() commit, or an
        # <iframe> focused in its container, which hands focus to the nested context).
        '__csimNoteFocusedRealm'   => ->(b, *a) { b.note_focused_realm(a[0]); nil },
        # This realm is a service-worker client: reported at document load and again whenever
        # control is installed, by the realm, because only it knows its own URL, frame type and
        # controller. `a[3]` is the controlling worker's handle, 0 when uncontrolled.
        '__csimNoteClient' => ->(b, *a) { b.sw_note_client(a[0], a[1], a[2], a[3], a[4]); nil },
        # A worker client's controller changed (claim adoption inside the worker isolate) —
        # update the HOST-owned record (a worker must not take the realm-style report path).
        '__csim_workerNoteController' => ->(b, *a) { b.sw_note_worker_controller(a[0], a[1]); nil },
        # A controlled worker's importScripts, through its SW's fetch event (synchronous
        # on the calling worker's thread — sw_import_script_fetch).
        '__csim_swImportFetch' => ->(b, *a) { b.sw_import_script_fetch(a[0], a[1], a[2]) },
        # A controlled client's fetch → the controlling SW's `fetch` event. Returns false if the SW
        # is gone (client falls back to the network).
        '__csim_serviceWorkerControllerFetch' => ->(b, *a) { b.service_worker_controller_fetch(a[0], a[1], a[2], a[3]) },
        # A controlled client cancelled a streaming respondWith body → cancel the SW's source stream
        # (routed to the worker that owns this [realm, fetch] stream). See sw_stream_cancel.
        '__csim_swStreamCancel'               => ->(b, *a) { b.sw_stream_cancel(a[0], a[1]); nil },
        # A registration's versions `[installing, waiting, active]` (each a worker's handle or null) — what every realm's
        # registration objects read — and a worker's `[script URL, type, state, registration]`.
        '__csim_swVersions'           => ->(b, *a) { b.sw_versions(a[0]) },
        '__csim_swWorker'             => ->(b, *a) { b.sw_worker(a[0]) },
        # A version's next lifecycle step, the task the host queued for it (see sw_step).
        '__csim_swStep'               => ->(b, *a) { b.sw_step(a[0]); nil },
        # The worker serving an EXACT scope (0 if none) — a service worker's own registration is live while it is one of
        # its versions.
        '__csim_swActiveHandleForScope' => ->(b, *a) { b.sw_active_handle_for_scope(a[0]) },
        # The registration map as a client of an origin reads it — `[id, scope]` each, in registration order — the
        # registration a URL matches, and the one at a scope (see sw_registrations_of).
        '__csim_swRegistrations'        => ->(b, *a) { b.sw_registrations_of(a[0]) },
        '__csim_swMatchRegistration'    => ->(b, *a) { b.sw_match_registration(a[0], a[1]) },
        '__csim_swRegisteredAt'         => ->(b, *a) { b.sw_registered_at(a[0]) },
        # Navigation Preload state (NavigationPreloadManager), keyed by the registration's scope —
        # reached identically from the client's registration and the worker's own. Get returns
        # {enabled, headerValue}; set leaves a nil field as-is.
        '__csim_swNavPreloadState'    => ->(b, *a) { b.nav_preload_state(a[0]) },
        '__csim_swNavPreloadSet'      => ->(b, *a) { b.nav_preload_set(a[0], a[1], a[2]); nil },
        # A navigation (iframe/document load) → its controlling SW's `fetch` event, awaited
        # synchronously. Returns the response wire hash, or nil to load from the network.
        '__csim_frameNavigationFetch' => ->(b, *a) { b.frame_navigation_fetch(a[0], a[2], is_reload: !!a[1], secure_ancestors: a[3].nil? || !!a[3], method: a[4] || 'GET', body: a[5], content_type: a[6], defer_ok: !!a[7], dest: a[8] || 'iframe', container_realm: a[9], referrer_policy: a[10], reloading_realm: a[11]) },
        '__csim_workerTerminate'     => ->(b, *a) { b.worker_terminate(a[0]); nil },
        # The font FILES native text metrics read (font.rs): a family's system face, as fontconfig resolves it;
        # an `@font-face` url's, fetched (WOFF-decoded, cached) with the fetch's facts for its Resource Timing
        # entry; the face installed under a `local()` name; a FontFace's own bytes — nil where there is none.
        '__csim_fontFile'            => ->(b, *a) { b.font_file(a[0], a[1]) },
        '__csim_webFontFetch'        => ->(b, *a) { b.web_font_fetch(a[0], a[1].to_i) },
        '__csim_localFontFile'       => ->(b, *a) { b.local_font_file(a[0], a[1] || '') },
        '__csim_resourceTimingFetch' => ->(b, *a) { b.resource_timing_fetch(a[0], a[1] == true, a[2] || 'same-origin') },
        '__csim_takeModuleRt'        => ->(b, *a) { b.take_module_rt },
        '__csim_takeWorkerRt'        => ->(b, *a) { b.take_worker_rt },
        '__csim_fontFileFromBytes'   => ->(b, *a) { b.font_file_from_bytes(a[0]) },
        '__csim_loadImage'           => ->(b, *a) { b.load_image(a[0], !!a[1], a[2] || 'same-origin', realm: a[3], referrer_policy: a[4], opaque: a[5] == true) },
        '__csim_imageLoadStart'      => ->(b, *a) { b.image_load_start(a[0], !!a[1], a[2] || 'same-origin', realm: a[3], referrer_policy: a[4], opaque: a[5] == true) },
        '__csim_blobRegister'        => ->(b, *a) { b.blob_register(a[0]); nil },
        '__csimBlobWindow'           => ->(b, *_a) { b.blob_window },
        '__csim_blobUnregister'      => ->(b, *a) { b.blob_unregister(a[0]); nil },
        # Any non-timer async channel (worker / SSE / hijacked fetch / window
        # message / websocket) still in flight — the WPT runner's drain consults
        # this so it doesn't bail before an async message (e.g. a freshly-spawned
        # worker's first postMessage) has had a chance to land.
        '__csim_asyncIoPending'      => ->(b, *_a) { b.async_io_pending? },
        '__csim_transferStash'       => ->(b, *a) { b.transfer_buffer_stash(a[0]) },
        '__csim_transferFetch'       => ->(b, *a) { b.transfer_buffer_fetch(a[0]) },
        # Zero-copy postMessage transfer-token bookkeeping (see Browser#drop_pending_transfers).
        '__csim_transferIssued'      => ->(b, *a) { b.transfer_token_issued(a[0]); nil },
        # Universal-server context (WPT runner)? Gates cross-origin eager frame
        # building: only there is a cross-origin iframe's content served locally,
        # so an ordinary app leaves cross-origin frames lazy (= baseline) and never
        # eager-@app.calls a foreign URL (side effects: extra visit / log row).
        '__csim_allHostsLocal'       => ->(b, *a) { b.send(:all_hosts_local?) },
        '__csim_videoBytes'          => ->(b, *a) { b.video_bytes(a[0], !!a[1], a[2] || 'same-origin', a[3]) },
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
        '__csimWebauthnAddVirtualAuthenticator'      => ->(b, *a) { b.webauthn.add_virtual_authenticator(a[0]) },
        '__csimWebauthnRemoveVirtualAuthenticator'   => ->(b, *a) { b.webauthn.remove_virtual_authenticator(a[0]); nil },
        '__csimWebauthnAddCredential'                => ->(b, *a) { b.webauthn.add_credential(a[0], a[1]); nil },
        '__csimWebauthnRemoveCredential'             => ->(b, *a) { b.webauthn.remove_credential(a[0], a[1]); nil },
        '__csimWebauthnGetCredentials'               => ->(b, *a) { b.webauthn.get_credentials(a[0]) },
        '__csimWebauthnSetUserVerified'              => ->(b, *a) { b.webauthn.set_user_verified(a[0], a[1]); nil },
        '__csimWebauthnSignalUnknownCredential'      => ->(b, *a) { b.webauthn.signal_unknown_credential(a[0], a[1]); nil },
        '__csimWebauthnSignalAllAcceptedCredentials' => ->(b, *a) { b.webauthn.signal_all_accepted_credentials(a[0], a[1], a[2]); nil }
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
      # …and a JS string that carries bytes, one per code unit (a form's encoded body: `latin1ToBytes`'s input), as the
      # bytes it carries.
      def self.latin1_bytes(s) = s.to_s.encode(Encoding::ISO_8859_1).b
    end
  end
end
