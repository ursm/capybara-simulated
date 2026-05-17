# frozen_string_literal: true

require 'time'

module Capybara
  module Simulated
    # HTTP/1.1 (RFC 9111) compliant response cache for `Browser#rack_fetch`.
    # Process-wide, GET-only, no Vary support — enough to mirror what a
    # real browser does for Rails-fingerprinted assets
    # (`Cache-Control: public, max-age=31536000, immutable`) which is the
    # request-volume difference behind Cuprite/Selenium being able to skip
    # 80–90 % of repeat asset fetches across a suite.
    #
    # Not cached:
    #   - Non-GET methods
    #   - Responses with `Cache-Control: no-store`
    #   - Responses with `Vary` header (any value — full Vary support deferred)
    #   - Responses with no freshness signal at all (no max-age, no Expires,
    #     no ETag/Last-Modified to revalidate against)
    #
    # Cached but always revalidated:
    #   - Responses with `Cache-Control: no-cache`
    #   - Stale entries with ETag or Last-Modified validators
    #
    # The cache hands the body bytes back to bridge.js verbatim; downstream
    # `__csim_runScript` bytecode caching is content-addressable
    # (sha256(body)), so identical body → identical bytecode falls out
    # naturally.
    class AssetCache
      Entry = Struct.new(:status, :headers, :body, :stored_at, :max_age, :etag, :last_modified, :must_revalidate, keyword_init: true) do
        def fresh?(now = Time.now)
          return false unless max_age
          return false if must_revalidate
          (now - stored_at) < max_age
        end

        def revalidatable? = !!(etag || last_modified)
      end

      # Status codes RFC 9111 §3 lists as "heuristically cacheable" — for
      # us, the GET / static-asset path. 304 is handled separately as the
      # revalidation response, not stored directly.
      CACHEABLE_STATUSES = [200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501].freeze

      def initialize
        @entries = {}
        @lock    = Mutex.new
      end

      def lookup(url) = @lock.synchronize { @entries[url] }

      # `status` Integer, `headers` Hash (case-insensitive lookup is the
      # caller's job — Rack 3 responses already use lowercase), `body`
      # String of raw bytes.
      def store(url, status, headers, body)
        return unless CACHEABLE_STATUSES.include?(status)
        return unless vary_compatible?(header(headers, 'vary'))
        cc = parse_cache_control(header(headers, 'cache-control'))
        return if cc[:no_store]
        max_age = cc[:max_age] || expires_to_max_age(header(headers, 'expires'), header(headers, 'date'))
        etag    = header(headers, 'etag')
        last_mod = header(headers, 'last-modified')
        # No freshness info and no validators → nothing useful to cache
        return if max_age.nil? && etag.nil? && last_mod.nil?
        entry = Entry.new(
          status:          status,
          headers:         headers,
          body:            body,
          stored_at:       Time.now,
          max_age:         max_age,
          etag:            etag,
          last_modified:   last_mod,
          must_revalidate: cc[:no_cache] || cc[:must_revalidate]
        )
        @lock.synchronize { @entries[url] = entry }
      end

      # `If-None-Match` / `If-Modified-Since` to add to a revalidation
      # request. Returns nil if no validators.
      def revalidation_headers(entry)
        h = {}
        h['If-None-Match']     = entry.etag          if entry.etag
        h['If-Modified-Since'] = entry.last_modified if entry.last_modified
        h.empty? ? nil : h
      end

      # Called when revalidation returned 304 — refresh stored_at /
      # max-age from the new response headers per RFC 9111 §4.3.4.
      def refresh(entry, new_headers)
        cc      = parse_cache_control(header(new_headers, 'cache-control'))
        max_age = cc[:max_age] || expires_to_max_age(header(new_headers, 'expires'), header(new_headers, 'date')) || entry.max_age
        @lock.synchronize {
          entry.stored_at       = Time.now
          entry.max_age         = max_age
          entry.must_revalidate = cc[:no_cache] || cc[:must_revalidate]
        }
        entry
      end

      def clear = @lock.synchronize { @entries.clear }
      def size  = @lock.synchronize { @entries.size }

      private

      # Vary fields we know are safe to ignore because Simulated never
      # sends the corresponding request header (so the cached response
      # is always the "no value" variant). `Accept-Encoding` is the
      # common one — Rails/Rack mark gzip-served assets with it, but
      # we never send Accept-Encoding and always receive the raw bytes.
      SAFE_VARY_FIELDS = %w[accept-encoding].freeze

      def vary_compatible?(vary)
        return true unless vary
        fields = vary.to_s.downcase.split(',').map(&:strip)
        return false if fields.include?('*')
        (fields - SAFE_VARY_FIELDS).empty?
      end

      # Rack 3 lowercases header names; Rack 2 / legacy apps don't.
      # Match case-insensitively so the same code paths work either way.
      def header(headers, name)
        return nil unless headers
        return headers[name] if headers.key?(name)
        target = name.downcase
        headers.each {|k, v| return v if k.to_s.downcase == target }
        nil
      end

      DIRECTIVE_RE = /\A(?<key>[a-zA-Z-]+)(?:=(?<val>.+))?\z/

      def parse_cache_control(value)
        out = {}
        return out unless value
        value.to_s.split(',').each {|part|
          m = part.strip.match(DIRECTIVE_RE)
          next unless m
          key = m[:key].downcase
          case key
          when 'no-store'         then out[:no_store]         = true
          when 'no-cache'         then out[:no_cache]         = true
          when 'must-revalidate'  then out[:must_revalidate]  = true
          when 'immutable'        then out[:immutable]        = true
          when 'max-age'          then out[:max_age]          = m[:val].to_i if m[:val]
          when 's-maxage'         then out[:max_age]        ||= m[:val].to_i if m[:val]
          end
        }
        out
      end

      # Translate `Expires` to a relative max-age using `Date` (or `now`).
      # RFC 9111 §4.2.1: if both Cache-Control max-age and Expires are
      # present, max-age wins — we already short-circuit on max-age first.
      def expires_to_max_age(expires, date)
        return nil unless expires
        exp_t  = Time.httpdate(expires) rescue nil
        return nil unless exp_t
        base_t = (date && (Time.httpdate(date) rescue nil)) || Time.now
        diff = (exp_t - base_t).to_i
        diff.positive? ? diff : 0
      end
    end
  end
end
