# frozen_string_literal: true

require 'json'

module Capybara
  module Simulated
    # The driver's commands to a session's virtual WebAuthn authenticators (`Browser#webauthn`), named as CDP's
    # `WebAuthn.*` are, and taking its options and credentials. The authenticators are the engine's (webauthn.rs).
    class Webauthn
      def initialize(session_partition)
        @session_partition = session_partition
      end

      def add_virtual_authenticator(options)
        Native.webauthn_add_authenticator(@session_partition, JSON.dump(options || {}))
      end

      def remove_virtual_authenticator(handle)
        Native.webauthn_remove_authenticator(@session_partition, handle.to_s)
      end

      # The credential's raw id, or nil for an authenticator no longer there; an ArgumentError for a credential that
      # WebAuthn's Add Credential command would refuse.
      def add_credential(handle, credential)
        Native.webauthn_add_credential(@session_partition, handle.to_s, JSON.dump(credential))
      end

      def remove_credential(handle, credential_id)
        Native.webauthn_remove_credential(@session_partition, handle.to_s, credential_id.to_s)
      end

      def get_credentials(handle)
        JSON.parse(Native.webauthn_credentials(@session_partition, handle.to_s))
      end

      def set_user_verified(handle, verified)
        Native.webauthn_set_user_verified(@session_partition, handle.to_s, !!verified)
      end
    end
  end
end
