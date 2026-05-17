# frozen_string_literal: true

require 'rack'
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
    #   - Responses with `Vary` listing anything other than `Accept-Encoding`
    #     (which we ignore because we never send it)
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
    #
    # No Mutex: MRI's Hash `[]`/`[]=` are atomic under the GVL, and Capybara
    # test suites are serial per-process (parallel_tests forks rather than
    # threads). A reader briefly racing a `refresh` may see a partial
    # `stored_at`/`max_age` pair — that just means freshness is computed
    # against a transient mix, never corrupted.
    class AssetCache
      Entry = Struct.new(:status, :headers, :body, :stored_at, :max_age, :must_revalidate, keyword_init: true) do
        def fresh?(now = Time.now)
          return false unless max_age
          return false if must_revalidate
          (now - stored_at) < max_age
        end
      end

      # RFC 9111 §3: status codes cacheable by default.
      CACHEABLE_STATUSES = [200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501].freeze

      # `Vary` fields we can safely ignore because Simulated never sends
      # the corresponding request header — the cached "no value" variant
      # is always applicable. `Accept-Encoding` is the common one Rails
      # adds to sprockets-served assets.
      SAFE_VARY_FIELDS = %w[accept-encoding].freeze

      def initialize
        @entries = {}
      end

      def lookup(url) = @entries[url]

      def store(url, status, headers, body)
        return unless CACHEABLE_STATUSES.include?(status)
        h = ensure_lowercase(headers)
        return unless vary_compatible?(h['vary'])
        cc = parse_cache_control(h['cache-control'])
        return if cc[:no_store]
        max_age = freshness_seconds(cc, h)
        # No freshness info and no validators → nothing useful to cache
        return if max_age.nil? && h['etag'].nil? && h['last-modified'].nil?
        @entries[url] = Entry.new(
          status:          status,
          headers:         h,
          body:            body,
          stored_at:       Time.now,
          max_age:         max_age,
          must_revalidate: cc[:no_cache] || cc[:must_revalidate]
        )
      end

      def revalidation_headers(entry)
        h = {}
        h['If-None-Match']     = entry.headers['etag']          if entry.headers['etag']
        h['If-Modified-Since'] = entry.headers['last-modified'] if entry.headers['last-modified']
        h
      end

      # RFC 9111 §4.3.4: a 304 refreshes the cached entry's freshness
      # window without replacing the body. Mutation under the GVL is fine
      # — see class-level Mutex note.
      def refresh(entry, new_headers)
        h  = ensure_lowercase(new_headers)
        cc = parse_cache_control(h['cache-control'])
        entry.stored_at       = Time.now
        entry.max_age         = freshness_seconds(cc, h) || entry.max_age
        entry.must_revalidate = cc[:no_cache] || cc[:must_revalidate]
        entry
      end

      private

      def freshness_seconds(cc, headers)
        cc[:max_age] || expires_to_max_age(headers['expires'], headers['date'])
      end

      def vary_compatible?(vary)
        return true unless vary
        fields = vary.to_s.downcase.split(',').map(&:strip)
        return false if fields.include?('*')
        (fields - SAFE_VARY_FIELDS).empty?
      end

      # Apps may return mixed-case header hashes on Rack 2; Rack 3 ships
      # lowercase. Normalise once per store/refresh — Rack::Headers's
      # `[]=` canonicalises keys, so subsequent O(1) lookups work either
      # way without per-call linear scans.
      def ensure_lowercase(headers)
        return headers if headers.is_a?(Rack::Headers)
        out = Rack::Headers.new
        headers.each {|k, v| out[k] = v }
        out
      end

      DIRECTIVE_RE = /\A(?<key>[a-zA-Z-]+)(?:=(?<val>.+))?\z/

      def parse_cache_control(value)
        out = {}
        return out unless value
        value.to_s.split(',').each {|part|
          m = part.strip.match(DIRECTIVE_RE)
          next unless m
          case m[:key].downcase
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
