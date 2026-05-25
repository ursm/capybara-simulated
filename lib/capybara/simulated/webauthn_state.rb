# frozen_string_literal: true

require 'openssl'
require 'securerandom'
require 'base64'
require 'json'

module Capybara
  module Simulated
    # Per-Browser virtual WebAuthn authenticator state. Mirrors the
    # subset of the WebAuthn Level 2 spec real apps (Discourse's
    # security key + passkey flows) exercise: ES256 keys, fmt="none"
    # attestation, AAGUID per authenticator, excludeCredentials +
    # userVerification + resident-key enforcement, and the CDP
    # `WebAuthn.*` surface that tests drive through
    # `cdp.with_virtual_authenticator`.
    class WebauthnState
      ES256_ALG = -7
      P256_CRV  = 1
      KTY_EC2   = 2

      # Flags byte in authenticator data (rfc8152 / WebAuthn level 2).
      FLAG_UP = 0x01  # User Present
      FLAG_UV = 0x04  # User Verified
      FLAG_BE = 0x08  # Backup Eligible
      FLAG_BS = 0x10  # Backup State
      FLAG_AT = 0x40  # Attested credential data included
      FLAG_ED = 0x80  # Extension data included

      DEFAULT_AAGUID = ("\x00" * 16).b.freeze

      # Mapped to DOMException name on the JS side. Apps branch on
      # `err.name` (`'InvalidStateError'`, `'NotAllowedError'`, …) so
      # the name has to survive the host-fn round-trip — `safe_call`
      # would otherwise flatten exception classes to a plain nil. The
      # host-fn wrapper in `runtime_shared.rb` rescues this class and
      # returns `{error:, name:}` to the JS shim instead.
      class Error < StandardError
        attr_reader :webauthn_name
        def initialize(name, message)
          super(message)
          @webauthn_name = name
        end
      end

      def initialize
        @authenticators = {}
        @next_handle    = 1
      end

      def add_virtual_authenticator(options)
        opts = (options || {}).transform_keys(&:to_s)
        handle = "csim-auth-#{@next_handle}"
        @next_handle += 1
        @authenticators[handle] = {
          options:     opts,
          credentials: {},
          aaguid:      DEFAULT_AAGUID
        }
        handle
      end

      def remove_virtual_authenticator(handle)
        @authenticators.delete(handle.to_s)
      end

      def add_credential(handle, credential)
        auth = @authenticators[handle.to_s] or return
        raw_id = Base64.urlsafe_decode64(credential['credentialId'].to_s)
        priv   = OpenSSL::PKey::EC.new(Base64.urlsafe_decode64(credential['privateKey'].to_s))
        auth[:credentials][raw_id] = Credential.new(
          raw_id:      raw_id,
          private_key: priv,
          rp_id:       credential['rpId'].to_s,
          sign_count:  credential['signCount'].to_i,
          resident:    !!credential['isResidentCredential'],
          user_handle: credential['userHandle'] ? Base64.urlsafe_decode64(credential['userHandle'].to_s) : nil
        )
        raw_id
      end

      def remove_credential(handle, credential_id_b64)
        auth = @authenticators[handle.to_s] or return
        auth[:credentials].delete(Base64.urlsafe_decode64(credential_id_b64.to_s))
      end

      def get_credentials(handle)
        auth = @authenticators[handle.to_s] or return []
        auth[:credentials].values.map {|c|
          {
            'credentialId'         => Base64.urlsafe_encode64(c.raw_id.b, padding: false),
            'rpId'                 => c.rp_id,
            'isResidentCredential' => c.resident,
            'signCount'            => c.sign_count,
            'userHandle'           => c.user_handle ? Base64.urlsafe_encode64(c.user_handle.b, padding: false) : nil
          }
        }
      end

      def set_user_verified(handle, verified)
        auth = @authenticators[handle.to_s] or return
        auth[:options]['isUserVerified'] = !!verified
      end

      def create(json)
        req  = JSON.parse(json.to_s)
        auth = pick_authenticator_for_create(req) or
               raise Error.new('NotAllowedError', 'no compatible virtual authenticator')

        rp_id     = req.dig('rp', 'id').to_s
        rp_id     = host_from_origin(req['origin']) if rp_id.empty?
        challenge = Base64.urlsafe_decode64(req['challenge'].to_s)
        user_id   = Base64.urlsafe_decode64(req.dig('user', 'id').to_s)
        opts      = auth[:options]

        unless (req['pubKeyCredParams'] || []).any? {|p| p['alg'].to_i == ES256_ALG }
          raise Error.new('NotSupportedError', 'no supported pubKeyCredParam (ES256 only)')
        end

        (req['excludeCredentials'] || []).each do |c|
          if auth[:credentials][Base64.urlsafe_decode64(c['id'].to_s)]
            raise Error.new('InvalidStateError', 'credential already registered on this authenticator')
          end
        end

        sel    = req['authenticatorSelection'] || {}
        uv_req = sel['userVerification']
        require_resident = %w[required preferred].include?(sel['residentKey']) ||
                           sel['requireResidentKey']
        if require_resident && !opts['hasResidentKey']
          raise Error.new('ConstraintError', 'resident-key required but authenticator does not support it')
        end
        if uv_req == 'required' && !user_verified?(opts)
          raise Error.new('NotAllowedError', 'user verification required but not performed')
        end

        key     = OpenSSL::PKey::EC.generate('prime256v1')
        raw_id  = SecureRandom.random_bytes(32)
        is_resident = !!(opts['hasResidentKey'] && require_resident)
        flags   = FLAG_UP | FLAG_AT
        flags  |= FLAG_UV if user_verified?(opts)
        # BE/BS mark the credential as syncable — clients use this to
        # decide whether to surface "passkey" UX vs "this device only".
        flags  |= (FLAG_BE | FLAG_BS) if opts['hasResidentKey'] && opts['hasUserVerification']

        auth_data = OpenSSL::Digest::SHA256.digest(rp_id) +
                    [flags].pack('C') +
                    [0].pack('N') +
                    auth[:aaguid] +
                    [raw_id.bytesize].pack('n') +
                    raw_id +
                    cose_ec2_pubkey(key)

        attestation_object = cbor_encode(
          'fmt'      => 'none',
          'attStmt'  => {},
          'authData' => CborBytes.new(auth_data)
        )

        client_data = JSON.dump(
          type:        'webauthn.create',
          challenge:   Base64.urlsafe_encode64(challenge.b, padding: false),
          origin:      req['origin'].to_s,
          crossOrigin: false
        )

        auth[:credentials][raw_id] = Credential.new(
          raw_id:      raw_id,
          private_key: key,
          rp_id:       rp_id,
          sign_count:  0,
          resident:    is_resident || !!opts['hasResidentKey'],
          user_handle: user_id
        )

        {
          'credentialId'      => Base64.urlsafe_encode64(raw_id.b, padding: false),
          'clientDataJSON'    => Base64.urlsafe_encode64(client_data.b, padding: false),
          'attestationObject' => Base64.urlsafe_encode64(attestation_object.b, padding: false)
        }
      end

      def get(json)
        req  = JSON.parse(json.to_s)

        rp_id     = req['rpId'].to_s
        rp_id     = host_from_origin(req['origin']) if rp_id.empty?
        challenge = Base64.urlsafe_decode64(req['challenge'].to_s)
        allow     = (req['allowCredentials'] || []).map {|c| Base64.urlsafe_decode64(c['id'].to_s) }
        uv_req    = req['userVerification']

        pick = pick_credential_for_get(rp_id, allow)
        raise Error.new('NotAllowedError', 'no matching credential') unless pick
        auth, cred = pick
        opts = auth[:options]

        if uv_req == 'required' && !user_verified?(opts)
          raise Error.new('NotAllowedError', 'user verification required but not performed')
        end

        cred.sign_count += 1

        flags  = FLAG_UP
        flags |= FLAG_UV if user_verified?(opts)
        flags |= (FLAG_BE | FLAG_BS) if cred.resident && opts['hasUserVerification']
        auth_data = OpenSSL::Digest::SHA256.digest(rp_id) +
                    [flags].pack('C') +
                    [cred.sign_count].pack('N')

        client_data = JSON.dump(
          type:        'webauthn.get',
          challenge:   Base64.urlsafe_encode64(challenge.b, padding: false),
          origin:      req['origin'].to_s,
          crossOrigin: false
        )

        signed_payload = auth_data + OpenSSL::Digest::SHA256.digest(client_data)
        signature      = cred.private_key.sign(OpenSSL::Digest::SHA256.new, signed_payload)

        # WebAuthn level 2: userHandle is only returned for resident
        # (discoverable) credentials. Real authenticators don't surface
        # the bound user for plain server-side credentials.
        user_handle_out = cred.resident && cred.user_handle && !cred.user_handle.empty? ?
                          Base64.urlsafe_encode64(cred.user_handle.b, padding: false) : nil

        {
          'credentialId'      => Base64.urlsafe_encode64(cred.raw_id.b, padding: false),
          'clientDataJSON'    => Base64.urlsafe_encode64(client_data.b, padding: false),
          'authenticatorData' => Base64.urlsafe_encode64(auth_data.b, padding: false),
          'signature'         => Base64.urlsafe_encode64(signature.b, padding: false),
          'userHandle'        => user_handle_out
        }
      end

      private

      def pick_authenticator_for_create(req)
        sel    = req['authenticatorSelection'] || {}
        uv_req = sel['userVerification']
        require_resident = %w[required preferred].include?(sel['residentKey']) ||
                           sel['requireResidentKey']
        compatible = @authenticators.values.select {|a|
          opts = a[:options]
          ok = true
          ok &&= !!opts['hasResidentKey'] if require_resident
          ok &&= user_verified?(opts)    if uv_req == 'required'
          ok
        }
        compatible.first || @authenticators.values.first
      end

      def pick_credential_for_get(rp_id, allow_ids)
        rp_match = ->(c) { c.rp_id.empty? || rp_id.empty? || c.rp_id == rp_id }
        if allow_ids.any?
          allow_ids.each do |id|
            @authenticators.each_value do |a|
              c = a[:credentials][id]
              return [a, c] if c && rp_match.call(c)
            end
          end
          return nil
        end
        # Discoverable (resident) first, then any credential bound to
        # this rpId — Chrome's virtual authenticator falls back the
        # same way in 2FA-only flows.
        [true, false].each do |resident_only|
          @authenticators.each_value do |a|
            c = a[:credentials].values.find {|x|
              (!resident_only || x.resident) && rp_match.call(x)
            }
            return [a, c] if c
          end
        end
        nil
      end

      def user_verified?(opts)
        return false unless opts['hasUserVerification']
        opts.fetch('isUserVerified', opts['automaticPresenceSimulation'])
      end

      def host_from_origin(origin)
        return '' if origin.nil? || origin.to_s.empty?
        URI.parse(origin.to_s).host.to_s
      rescue URI::InvalidURIError
        ''
      end

      def cose_ec2_pubkey(ec_key)
        bytes = ec_key.public_key.to_octet_string(:uncompressed)
        x = bytes[1, 32].b
        y = bytes[33, 32].b
        cbor_encode(
          1  => KTY_EC2,
          3  => ES256_ALG,
          -1 => P256_CRV,
          -2 => CborBytes.new(x),
          -3 => CborBytes.new(y)
        )
      end

      # No tags, no floats, no indefinite-length items — just the
      # primitives WebAuthn attestation + COSE keys need.
      def cbor_encode(value)
        case value
        when Integer
          if value >= 0
            cbor_head(value, 0x00)
          else
            cbor_head(-1 - value, 0x20)
          end
        when String
          utf8 = value.encode(Encoding::UTF_8)
          cbor_head(utf8.bytesize, 0x60) + utf8.b
        when CborBytes
          cbor_head(value.bytes.bytesize, 0x40) + value.bytes
        when Hash
          out = cbor_head(value.size, 0xA0)
          value.each do |k, v|
            out << cbor_encode(k)
            out << cbor_encode(v)
          end
          out
        when Array
          out = cbor_head(value.size, 0x80)
          value.each {|e| out << cbor_encode(e) }
          out
        when true, false
          [value ? 0xF5 : 0xF4].pack('C').b
        when nil
          [0xF6].pack('C').b
        else
          raise "Unsupported CBOR type: #{value.class}"
        end
      end

      def cbor_head(n, type_tag)
        if n < 24
          [type_tag | n].pack('C').b
        elsif n < 256
          [type_tag | 24, n].pack('CC').b
        elsif n < 65_536
          [type_tag | 25, n].pack('Cn').b
        elsif n < 2**32
          [type_tag | 26, n].pack('CN').b
        else
          [type_tag | 27, n].pack('CQ>').b
        end
      end

      CborBytes = Struct.new(:bytes)

      class Credential
        attr_accessor :raw_id, :private_key, :rp_id, :sign_count, :resident, :user_handle

        def initialize(raw_id:, private_key:, rp_id:, sign_count: 0, resident: false, user_handle: nil)
          @raw_id      = raw_id
          @private_key = private_key
          @rp_id       = rp_id
          @sign_count  = sign_count
          @resident    = resident
          @user_handle = user_handle
        end
      end
    end
  end
end
