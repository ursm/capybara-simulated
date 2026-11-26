# frozen_string_literal: true

module Capybara
  module Simulated
    # The engine-facing constants and tables — JS asset paths, the
    # host-fn table that bridge.js reaches back through, the
    # error-swallowing wrapper. `V8Runtime` plugs the table into
    # rusty_racer's `Context#attach` for the main realm and every
    # worker isolate alike.
    module RuntimeShared
      BRIDGE_JS        = File.expand_path('js/bridge.bundle.js',                 __dir__).freeze
      VENDOR_BUNDLE_JS = File.expand_path('../../../vendor/js/vendor.bundle.js', __dir__).freeze

      def self.bridge_src        = File.read(BRIDGE_JS)
      def self.vendor_bundle_src = File.read(VENDOR_BUNDLE_JS)

      # Combined source baked into the V8 Snapshot: the vendor bundle first (so bridge can take
      # `globalThis.__csimVendor.streams`, streams.js), then bridge proper. The host's procs are no part
      # of it: they land on each realm's host object as it is made (`Context#attach('@…')`), which the
      # bindings take then (engine.js `hostObject`).
      def self.snapshot_src
        vendor_bundle_src + ";\n" + bridge_src
      end

      # Host fns whose body touches `Browser` — wrap with `safe_call`
      # so a Ruby-side bug in the Browser path doesn't propagate as a
      # JS exception that crashes the whole script chain. Bodies take
      # `(browser, *js_args)` and return whatever the JS caller expects.
      BROWSER_HOST_FNS = {
        'rackFetch'                    => ->(b, *a) { b.rack_fetch_request(a[0], a[1]) },
        'externalAsset'                => ->(b, *a) { b.planned_external_asset(a[0], a[1], a[2], a[3], a[4], since: a[5], waits: a[6] != false) },
        'subresourceFetch'             => ->(b, *a) { b.subresource_fetch(a[0], a[1].to_i, a[2]) },
        'assetDocumentStarted'         => ->(b, *_a) { b.asset_document_started },
        # fetch(…, {keepalive}) — eager detached-thread dispatch + one-shot result poll.
        'keepaliveStart'               => ->(b, *a) { b.keepalive_start(a[0], a[1]) },
        'keepaliveTake'                => ->(b, *a) { b.keepalive_take(a[0]) },
        # A controlled document's subresource → its controller's fetch event, synchronously, its
        # request the plan's (its destination too). See sw_script_subresource_fetch.
        'swScriptFetch'                => lambda {|b, *a|
          mode, credentials, _, _, destination = Native.subresource_plan_fields(a[4].to_i)
          b.sw_script_subresource_fetch(a[0], a[1], a[2], a[3], destination, mode, credentials, binary: a[5] == true, integrity: a[6] || '', referrer_policy: a[7], client: a[8])
        },
        # A frame's navigation by its container (a `src` change, the host's of a URL no fetch here answers) commits: the
        # session-history entry it makes made now (snapshotting the OUTGOING document), so history.go(-1) can traverse
        # back — after the active one, or (a[3]) in its place: the navigation's history handling (frame_navigation.rs
        # `frameAttributesNavigate`). Must run while the outgoing realm (a[0]) is still alive.
        'recordFrameNav'               => ->(b, *a) { b.commit_frame_entry(a[0].to_i, a[1], srcdoc: a[2], replace: a[3] == true); nil },
        # …and the outgoing document unloaded (a[0] its realm, alive still): the entry takes its form state as its
        # pagehide / unload handlers left it.
        'frameUnloaded'                => ->(b, *a) { b.frame_document_unloaded(a[0].to_i); nil },
        'setTimersActive'              => ->(b, *a) { b.timers_active = !!a[0]; nil },
        'navigationTurnQueued'         => ->(b, *_a) { b.navigation_turn_queued = true; nil },
        'readFilePick'                 => ->(b, *a) { b.read_file_pick(a[0], a[1], a[2], a[3]) },
        'getDocumentCookie'            => ->(b, *a) { b.document_cookie(a[0], a[1], a[2]) },
        'setDocumentCookie'            => ->(b, *a) { b.write_document_cookie(a[0].to_s, a[1], a[2], a[3]); nil },
        'deleteAllCookies'             => ->(b, *_) { b.delete_all_cookies; nil },
        'storagePartitions'            => ->(b, *_a) { b.storage_partitions },
        # A window `window.open` made in this isolate closing, or closed (window.js): its RealmWindow asks again.
        'windowRealmsChanged'          => ->(b, *_a) { b.window_realms_changed; nil },
        'storageChanged'               => ->(b, *a) { b.storage_changed(*a[0, 7]); nil },
        'modalDialog'                  => ->(b, *a) { b.handle_modal(a[0], a[1], a[2], a[3]) },
        'logConsole'                   => ->(b, *a) { b.log_console(a[0], a[1]); nil },
        'eventSourceOpen'              => ->(b, *a) { b.event_source_open(a[0]) },
        'eventSourceClose'             => ->(b, *a) { b.event_source_close(a[0]); nil },
        'wsOpen'                       => ->(b, *a) { b.ws_open(a[0]) },
        'wsSend'                       => ->(b, *a) { b.ws_send(a[0], a[1], a[2]); nil },
        'wsClose'                      => ->(b, *a) { b.ws_close(a[0], a[1], a[2]); nil },
        'rackFetchAsync'               => ->(b, *a) { b.rack_fetch_async(a[0], a[1]) },
        'rackFetchAsyncAbort'          => ->(b, *a) { b.rack_fetch_async_abort(a[0]); nil },
        # `window.open`: a new window of this window's browsing context group, a realm of this isolate (its number), or —
        # noopener — a browsing context group of its own (nil). a[2] is the opener's realm id (for wiring window.opener);
        # a[3] the opener document's base URL, which an about:blank popup inherits.
        'windowOpen'                   => ->(b, *a) { b.open_child_window(*a[0, 6]) },
        # A `target=_blank`/named link/area activation from a frame or window realm:
        # open a new auxiliary window (the realm's VM isn't rebuilt — a fresh window
        # is). `opener` = rel=opener (target=_blank defaults to noopener); the Driver
        # forces noopener for a cross-partition blob: target.
        'openAuxFromRealm'             => ->(b, *a) { b.open_aux_from_realm(*a[0, 6]); nil },
        'broadcast'                    => ->(b, *a) { b.broadcast_to_windows(a[0], a[1], a[2].to_i, a[3]) == true },
        # BroadcastChannel's multi-realm path: the isolate queues one ordered delivery per channel (broadcast_channels.rs
        # `bcQueue`), the host the other windows' and the workers' (`broadcast_queued`). Only taken where a sibling
        # same-isolate realm exists (`bc_siblings_exist?`); single-window pages never touch it.
        'broadcastQueued'              => ->(b, *a) { b.broadcast_queued(a[0], a[1], a[2]) == true },
        'bcSiblingsExist'              => ->(b, *_a) { b.bc_siblings_exist? },
        # The session's partition of the storage registries — IndexedDB's, which every realm and worker of it is an agent
        # of, and Cache Storage's (idb_databases.rs, cache_storage.rs).
        'sessionPartition'             => ->(b, *_a) { b.session_partition },
        # …and the space the window's environment ids are minted in (Browser#client_space).
        'clientSpace'                  => ->(b, *_a) { b.client_space },
        # (…this window's page set closing by its script, its close a task of its own)
        'windowClose'                  => ->(b, *_a) { b.script_close; nil },
        # a[3] is the CREATING realm (the worker dies when it is discarded); a[4] that context's
        # CURRENT controller handle, which a DEDICATED worker inherits rather than scope-matching
        # its own — often opaque (blob:/data:) — script URL. 0 when the creator is uncontrolled.
        'workerSpawn'                  => ->(b, *a) { b.worker_spawn(a[0], shared: !!a[1], creator_key: a[2], realm_id: a[3].to_i, controller_handle: a[4].to_i, script_type: a[5], name: a[6].to_s, cluster_key: a[7], isolated: a[8] == true, at: a[9], epoch_at: a[10], shift: a[11], travel: a[12], credentials: a[13], secure: a[14] == true) },
        # A register(), update() or unregister(), scheduled as a job at its scope (see sw_schedule_job), and the job run, the task
        # queued for it — and the registration's updateViaCache mode, REGISTRATION-wide state (a frame's
        # registration object must see the mode the top window set). (…each of the storage key whose top-level site the
        # last argument is, the caller's: sw_registry.rs)
        'swScheduleJob'                => ->(b, *a) { b.sw_schedule_job(*a.first(11)) },
        'swRunJob'                     => ->(b, *a) { b.sw_run_job(a[0]); nil },
        'swScopeUpdateViaCache'        => ->(b, *a) { b.sw_scope_update_via_cache(a[0], a[1].to_s) },
        'swNoteImport'                 => ->(b, *a) { b.sw_note_import(a[0].to_i, a[1], a[2]) },
        'workerPostToWorker'           => ->(b, *a) { b.worker_post_to_worker(a[0], a[1]); nil },
        # ServiceWorker.postMessage from a client, or a service worker → the SW's `message` event (source = the sender).
        'serviceWorkerPostMessage'     => ->(b, *a) { b.service_worker_post_message(a[0], a[1], a[2], a[3], a[4].to_i); nil },
        # Cross-isolate MessagePort channels (a window or frame realm's side): the ends its ports take and give up, and
        # what they post.
        'clientPortEndHere'            => ->(b, *a) { b.port_end_here(a[0], [:realm, a[1].to_i]); nil },
        'clientPortEndGone'            => ->(b, *a) { b.port_end_gone(a[0], a[1], [:realm, a[2].to_i]); nil },
        'clientPortEndClosed'          => ->(b, *a) { b.port_end_closed(a[0]); nil },
        'clientPortRedeliver'          => ->(b, *a) { b.port_redeliver(a[0], a[1]); nil },
        'clientPortPost'               => ->(b, *a) { b.port_post(a[0], a[1]) == true },
        # The focus chain moved into this realm's browsing context (a focus() commit, or an
        # <iframe> focused in its container, which hands focus to the nested context).
        'focusChanged'                 => ->(b, *_) { b.focus_changed; nil },
        # This realm is a service-worker client: reported by the realm as its document is created
        # (`a[3]` the worker that controls it, 0 none) and again as it loads (`a[3]` nil: kept), as
        # only it knows its own URL and frame type. The registry's partition, which it reads its
        # controller in (sw_registry.rs `swController`).
        'noteClient'                   => ->(b, *a) { b.sw_note_client(a[0], a[1], a[2], a[3], a[4], site: a[5].to_s) },
        # A controlled worker's importScripts, through its SW's fetch event (synchronous
        # on the calling worker's thread — sw_import_script_fetch).
        'swImportFetch'                => ->(b, *a) { b.sw_import_script_fetch(a[0], a[1], a[2]) },
        # A controlled client's fetch → the controlling SW's `fetch` event. Returns false if the SW
        # is gone (client falls back to the network).
        'serviceWorkerControllerFetch' => ->(b, *a) { b.service_worker_controller_fetch(a[0], a[1], a[2], a[3]) },
        # …a synchronous request's (a sync XHR, a[3] its `timeout`), its answer awaited in place: the wire JSON, or nil for
        # the network.
        'serviceWorkerSyncFetch'       => ->(b, *a) { b.service_worker_sync_fetch(a[0], a[1], a[2], a[3].to_i) },
        # A controlled client cancelled a streaming respondWith body → cancel the SW's source stream
        # (routed to the worker that owns this [realm, fetch] stream). See sw_stream_cancel.
        'swStreamCancel'               => ->(b, *a) { b.sw_stream_cancel(a[0], a[1]); nil },
        # A registration's versions `[installing, waiting, active]` (each a worker's handle or null) — what every realm's
        # registration objects read — and a worker's `[script URL, type, state, registration]`.
        'swVersions'                   => ->(b, *a) { b.sw_versions(a[0]) },
        'swWorker'                     => ->(b, *a) { b.sw_worker(a[0]) },
        # A version's next lifecycle step, the task the host queued for it (see sw_step).
        'swStep'                       => ->(b, *a) { b.sw_step(a[0]); nil },
        # The registration map as a client of an origin reads it — `[id, scope]` each, in registration order — the
        # registration a URL matches, and the one at a scope (see sw_registrations_of).
        'swRegistrations'              => ->(b, *a) { b.sw_registrations_of(a[0], a[1].to_s) },
        'swMatchRegistration'          => ->(b, *a) { b.sw_match_registration(a[0], a[1], a[2].to_s) },
        'swRegisteredAt'               => ->(b, *a) { b.sw_registered_at(a[0], a[1].to_s) },
        # Navigation Preload state (NavigationPreloadManager), keyed by the registration's scope —
        # reached identically from the client's registration and the worker's own. Get returns
        # {enabled, headerValue}; set leaves a nil field as-is.
        'swNavPreloadState'            => ->(b, *a) { b.nav_preload_state(a[0], a[1].to_s) },
        'swNavPreloadSet'              => ->(b, *a) { b.nav_preload_set(a[0], a[1], a[2], a[3].to_s); nil },
        # A navigation (iframe/document load) → its controlling SW's `fetch` event, awaited
        # synchronously. Returns the response wire hash, or nil to load from the network.
        # (…its server's time counted, not ticked, where the build can wait for it — `a[13]`: Browser#server_timed)
        'frameNavigationFetch'         => lambda {|b, *a|
          fetch = -> { b.frame_navigation_fetch(a[0], a[2], is_reload: !!a[1], secure_ancestors: a[3].nil? || !!a[3], defer_ok: !!a[4], dest: a[5] || 'iframe', container_realm: a[6], referrer_policy: a[7], initiator_realm: a[8], sandbox: [a[9]], user_activated: a[10] == true, link_policy: a[11], replaces_realm: a[12]) }
          a[13] == true ? b.server_timed(&fetch) : fetch.call
        },
        'workerTerminate'              => ->(b, *a) { b.worker_terminate(a[0]); nil },
        # The font FILES native text metrics read (font.rs): a family's system face, as fontconfig resolves it;
        # an `@font-face` url's, fetched (WOFF-decoded, cached) with the fetch's facts for its Resource Timing
        # entry; the face installed under a `local()` name; a FontFace's own bytes — nil where there is none.
        'fontFile'                     => ->(b, *a) { b.font_file(a[0], a[1]) },
        'webFontFetch'                 => ->(b, *a) { b.web_font_fetch(a[0], a[1].to_i, a[2], a[3]) },
        'fontFetchStart'               => ->(b, *a) { b.font_fetch_start(a[0], a[1].to_i, a[2], a[3], a[4]) },
        'fontFileKnown'                => ->(b, *a) { b.font_file_known(a[0], a[1].to_i, a[2], a[3])&.first },
        'localFontFile'                => ->(b, *a) { b.local_font_file(a[0], a[1] || '') },
        'resourceTimingFetch'          => ->(b, *a) { b.resource_timing_fetch(a[0], a[1].to_i, a[2], a[3]) },
        'takeModuleRt'                 => ->(b, *a) { b.take_module_rt },
        'takeWorkerRt'                 => ->(b, *a) { b.take_worker_rt },
        'fontFileFromBytes'            => ->(b, *a) { b.font_file_from_bytes(a[0]) },
        'loadImage'                    => ->(b, *a) { b.load_image(a[0], a[2], realm: a[1], referrer: a[3]) },
        'imageLoadStart'               => ->(b, *a) { b.image_load_start(a[0], a[2], realm: a[1]) },
        'scriptFetchStart'             => ->(b, *a) { b.script_fetch_start(a[0], a[1], a[2], a[3], a[4], a[5].to_f, a[6], excuse: a[7] == true) },
        'scriptFetchTake'              => ->(b, *a) { b.script_fetch_take(a[0]) },
        'moduleFetchStart'             => ->(b, *a) { b.module_fetch_start(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7].to_f, a[8], a[9].to_f, a[10]) },
        'scriptFetchForget'            => ->(b, *a) { b.script_fetch_forget(a[0]) },
        'scriptFetchesForgetRealm'     => ->(b, *a) { b.script_fetches_forget_realm(a[0]) },
        'spinServeWorkers'             => ->(b, *a) { b.spin_serve_workers(a[0]); nil },
        # …and the server's time a parser-blocking script's fetch took past its date, the event loop run on for it.
        'serverSlept'                  => ->(b, *a) { b.server_slept_ms(a[0].to_f); nil },
        'blobWindow'                   => ->(b, *_a) { b.blob_window },
        'blobUnregister'               => ->(b, *a) { b.blob_unregister(a[0], a[1]); nil },
        'partitionBlob'                => ->(b, *a) { b.partition_blob(a[0], a[1]) },
        'blobShared'                   => ->(b, *_a) { b.blob_shared? },
        # Any non-timer async channel (worker / SSE / hijacked fetch / window
        # message / websocket) still in flight — the WPT runner's drain consults
        # this so it doesn't bail before an async message (e.g. a freshly-spawned
        # worker's first postMessage) has had a chance to land.
        'asyncIoPending'               => ->(b, *_a) { b.async_io_pending? },
        'transferStash'                => ->(b, *a) { b.transfer_buffer_stash(a[0]) },
        'transferFetch'                => ->(b, *a) { b.transfer_buffer_fetch(a[0]) },
        # Zero-copy postMessage transfer-token bookkeeping (see Browser#drop_pending_transfers).
        'transferIssued'               => ->(b, *a) { b.transfer_token_issued(a[0]); nil },
        'moduleIssued'                 => ->(b, *a) { b.module_token_issued(a[0]); nil },
        'videoBytes'                   => ->(b, *a) { b.video_bytes(a[0], a[2], realm: a[1]) }
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

      # A module graph the engine's module map handed over (module_map.rs `moduleGraphResult`: `[root, base, [specifier,
      # record, …], …]`) taken into a realm's `table` — its records by number, the links of each module by its base URL —
      # and its root's record returned linked: each module's requests resolved to the records the map handed over for them,
      # in the order V8 asks — its module requests' (the map read them off the same compile) — none where one is missing.
      class ModuleLinkFailed < StandardError; end
      # A module's parse error (HTML "module script"'s), or its graph's link error to rethrow, of V8's message for a failure
      # of the module at `url` (`SyntaxError: Unexpected token ';' at http://…/m.js:1`): `[name, message, filename, lineno]` —
      # its kind, its text, and the location the host appended to it (that URL, which may hold spaces — a `data:` one's —
      # and a line; none for a failure the host names no location of: a link's) — which the bridge reports at its global,
      # making the error anew (the value V8 threw is its once, and only as it is thrown).
      def self.module_error(text, url = nil)
        text = text.to_s
        at   = url && text.match(/ at #{Regexp.escape(url.to_s)}(?::(\d+))?\z/)
        text = text[0, at.begin(0)] if at
        name, message = text.split(': ', 2)
        name, message = 'SyntaxError', name.to_s unless message
        [name, message, at && url.to_s, at&.[](1)&.to_i]
      end
      def self.linked_module(table, result)
        root, *links = result
        links.each_slice(2) {|base, pairs| table[:links][base.to_s] = pairs.each_slice(2).to_a }
        m = table[:records][root.to_i] or return nil
        return m unless m.status == :uninstantiated

        asked = Hash.new(0)
        m.instantiate do |specifier, referrer|
          requests = table[:links][referrer.to_s] || []
          at = asked[referrer]
          at = requests.index {|s, _| s == specifier } unless requests[at]&.first == specifier
          raise ModuleLinkFailed, "module not found: #{specifier}" unless at

          asked[referrer] = at + 1
          table[:records][requests[at][1].to_i] or raise ModuleLinkFailed, "module not found: #{specifier}"
        end
        m
      end
    end
  end
end
