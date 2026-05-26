# frozen_string_literal: true

require 'base64'
require 'openssl'
require 'securerandom'

require_relative 'webauthn_state'

require_relative 'url_shape'

module Capybara
  module Simulated
    # Bits common to `V8Runtime` and `QuickJSRuntime` — JS asset paths,
    # the host-fn table that bridge.js reaches back through, the
    # error-swallowing wrapper. Each engine plugs the table into its
    # own attach API (mini_racer's `Context#attach` vs quickjs.rb's
    # `Quickjs::VM#define_function`).
    module RuntimeShared
      BRIDGE_JS         = File.expand_path('js/bridge.bundle.js',                 __dir__).freeze
      SNAPSHOT_STUBS_JS = File.expand_path('js/snapshot_stubs.js',                __dir__).freeze
      WGXPATH_JS        = File.expand_path('../../../vendor/js/wgxpath.js',       __dir__).freeze
      VENDOR_BUNDLE_JS  = File.expand_path('../../../vendor/js/vendor.bundle.js', __dir__).freeze

      def self.snapshot_stubs_src = File.read(SNAPSHOT_STUBS_JS)
      def self.bridge_src         = File.read(BRIDGE_JS)
      def self.wgxpath_src        = File.read(WGXPATH_JS)
      def self.vendor_bundle_src  = File.read(VENDOR_BUNDLE_JS)

      # Combined source baked into the V8 Snapshot / QuickJS bytecode.
      # Order matters: stubs first (so bridge's IIFE can reference the
      # `globalThis.__rackFetch` etc. slots), then the vendor bundle
      # (so bridge can reference `globalThis.__csimVendor.cssSelect`),
      # then bridge proper, then wgxpath, finally the install hook
      # that ties wgxpath's `Document.prototype.evaluate` to the live
      # document the bridge created.
      def self.snapshot_src
        snapshot_stubs_src +
          vendor_bundle_src + ";\n" +
          bridge_src +
          wgxpath_src + ";\n" +
          "wgxpath.install(globalThis);\n"
      end

      # Host fns whose body touches `Browser` — wrap with `safe_call`
      # so a Ruby-side bug in the Browser path doesn't propagate as a
      # JS exception that crashes the whole script chain. Bodies take
      # `(browser, *js_args)` and return whatever the JS caller expects.
      BROWSER_HOST_FNS = {
        '__rackFetch'                => ->(b, *a) { b.rack_fetch(a[0], a[1], a[2], a[3], a[4]) },
        '__locationAssign'           => ->(b, *a) { b.location_assign(a[0]); nil },
        '__locationReload'           => ->(b, *_) { b.location_reload; nil },
        '__setTimersActive'          => ->(b, *a) { b.timers_active = !!a[0]; nil },
        '__setCurrentUrl'            => ->(b, *a) { b.history_state(a[0], a[1]); nil },
        '__pushHistoryEntry'         => ->(b, *a) { b.history_push(a[0], a[1]); nil },
        '__historyGo'                => ->(b, *a) { b.history_go(a[0]); nil },
        '__csimReadFilePick'         => ->(b, *a) { b.read_file_pick(a[0], a[1], a[2], a[3]) },
        '__getDocumentCookie'        => ->(b, *_) { b.document_cookie },
        '__setDocumentCookie'        => ->(b, *a) { b.write_document_cookie(a[0].to_s); nil },
        '__csim_storageGet'          => ->(b, *a) { b.storage_get(a[0], a[1]) },
        '__csim_storageSet'          => ->(b, *a) { b.storage_set(a[0], a[1], a[2]); nil },
        '__csim_storageRemove'       => ->(b, *a) { b.storage_remove(a[0], a[1]); nil },
        '__csim_storageClear'        => ->(b, *a) { b.storage_clear(a[0]); nil },
        '__csim_storageKey'          => ->(b, *a) { b.storage_key(a[0], a[1]) },
        '__csim_storageLength'       => ->(b, *a) { b.storage_length(a[0]) },
        '__modalDialog'              => ->(b, *a) { b.handle_modal(a[0], a[1], a[2]) },
        '__csim_fetchModuleSource'   => ->(b, *a) { b.load_module(a[0]) },
        '__csim_pushImportmap'       => ->(b, *a) { b.set_importmap(a[0]); nil },
        '__csim_logConsole'          => ->(b, *a) { b.log_console(a[0], a[1]); nil },
        '__csim_eventSourceOpen'     => ->(b, *a) { b.event_source_open(a[0]) },
        '__csim_eventSourceClose'    => ->(b, *a) { b.event_source_close(a[0]); nil },
        '__csim_workerSpawn'         => ->(b, *a) { b.worker_spawn(a[0]) },
        '__csim_workerPostToWorker'  => ->(b, *a) { b.worker_post_to_worker(a[0], a[1]); nil },
        '__csim_workerTerminate'     => ->(b, *a) { b.worker_terminate(a[0]); nil },
        '__csim_decodeImage'         => ->(b, *a) { b.decode_image(a[0], a[1], a[2]) },
        '__csim_blobRegister'        => ->(b, *a) { b.blob_register(a[0], a[1]); nil },
        '__csim_blobResolve'         => ->(b, *a) { b.blob_resolve(a[0]) },
        '__csim_blobUnregister'      => ->(b, *a) { b.blob_unregister(a[0]); nil },
        '__csim_transferStash'       => ->(b, *a) { b.transfer_buffer_stash(a[0]) },
        '__csim_transferFetch'       => ->(b, *a) { b.transfer_buffer_fetch_for_js(a[0]) },
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
      STDLIB_HOST_FNS = {
        '__csim_randomUUID'   => ->(*_) { SecureRandom.uuid },
        '__csim_randomBytes'  => ->(*a) { SecureRandom.bytes(a[0].to_i).bytes },
        '__csim_atob'         => ->(*a) { Base64.decode64(a[0].to_s) },
        '__csim_btoa'         => ->(*a) { Base64.strict_encode64(a[0].to_s) },
        '__csim_utf8Encode'   => ->(*a) { a[0].to_s.b.bytes },
        '__csim_utf8Decode'   => ->(*a) { a[0].pack('C*').force_encoding('UTF-8') },
        '__csim_parseUrl'     => ->(*a) { UrlShape.parse_for_js(a[0], a[1]) },
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
        nil
      end
    end
  end
end
