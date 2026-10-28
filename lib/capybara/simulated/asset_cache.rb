# frozen_string_literal: true

require 'rack'

module Capybara
  module Simulated
    # The HTTP cache (RFC 9111) of `Browser#rack_fetch`: process-wide, GET-only — enough to mirror what a real browser
    # does for Rails-fingerprinted assets (`Cache-Control: public, max-age=31536000, immutable`), which is the
    # request-volume difference behind Cuprite/Selenium being able to skip 80–90 % of repeat asset fetches across a suite.
    #
    # Its POLICY is the engine's (http_cache.rs): which responses are stored — a status cacheable by default, no
    # `no-store`, no `private` (this cache is shared across the test sessions of a process), no Vary but on
    # Accept-Encoding (never sent), and a lifetime or a validator to go on — how long one stays fresh (max-age, else
    # Expires less Date, else a heuristic tenth of the time since Last-Modified, less the age it came with), and what a 304
    # updates. This keeps the responses, their bodies verbatim: downstream `__csim_runScript` bytecode caching is
    # content-addressable (sha256(body)), so identical body → identical bytecode falls out naturally.
    #
    # No Mutex: MRI's Hash `[]`/`[]=` are atomic under the GVL. Concurrent access is
    # real — async image loads (and keepalive fetches) run `rack_fetch` on background
    # threads while the main thread fetches too — but every operation here is a single
    # GVL-atomic Hash read or write of an immutable-once-built Entry, so the worst a
    # racing reader sees is a partial `stored_at`/`max_age` pair on `refresh`: freshness
    # computed against a transient mix, never a corrupted structure.
    class AssetCache
      # `max_age` the seconds it stays fresh from `stored_at` (nil for none: revalidated each use), `no_cache` whether every
      # use revalidates it, `immutable` whether it outlives a test's reset; `encoded` the body's size on the wire before a
      # Content-Encoding was undone — what a cache hit's Resource Timing entry reports as `encodedBodySize`.
      Entry = Struct.new(:status, :headers, :body, :stored_at, :max_age, :no_cache, :immutable, :encoded, keyword_init: true) do
        def fresh?(now = Time.now) = Native.http_cache_fresh(stored_at.to_f, max_age, no_cache == true, now.to_f)
      end

      # The response fields the policy reads (http_cache.rs `Fields`).
      POLICY_FIELDS = %w[cache-control expires date last-modified etag vary age].freeze

      # Immutable entries live for the PROCESS now (they survive every reset), and a long app
      # suite mints fresh content-addressed URLs per example (Discourse's per-test themes and
      # colour schemes → new `/theme-javascripts/<sha1>.js` / `/stylesheets/*_<hash>.css`), so
      # the map is bounded the way `@@asset_src` is: wipe and restart when it fills.
      MAX_ENTRIES = 4096

      # A response header's value as one: each of its fields — a Rack 3 app may give an Array of them — without the HTTP
      # whitespace around it, as an HTTP stack reads a field (Chrome and Firefox: ` 5 ` is `5`), combined with ", " as an
      # HTTP response's header list combines them — as bytes, whatever encoding each is tagged with; nil for none.
      def self.combined(value)
        return nil if value.nil?
        Array(value).map {|field| field.to_s.b.sub(/\A[\t ]+/n, '').sub(/[\t ]+\z/n, '') }.join(', ')
      end

      def initialize
        @entries = {}
      end

      def lookup(url) = @entries[url]
      def clear      = @entries.clear

      # Per-test reset path: keep entries the server marked
      # `Cache-Control: immutable` (declared not to change for their
      # freshness lifetime, so a kept entry can't shadow a later test's
      # response — a real browser keeps them across navigations the same
      # way) and drop everything else, so test-local DB state reaches the
      # app on the next visit. This read `reject!` — the exact inverse —
      # from the day it was written: every immutable asset was re-fetched
      # once per example (Discourse's `/extra-locales/<sha1>/en/mf.js`
      # alone is a 41 ms Rails render), while max-age'd non-immutable
      # responses survived into the next test.
      def clear_volatile
        @entries.select! {|_, e| e.immutable }
      end

      def store(url, status, headers, body, encoded: nil)
        h = ensure_lowercase(headers)
        # (…its cookies not kept: they were set as the response came, and a replay is no response that sets them)
        h.delete('set-cookie')
        now = Time.now
        stored = Native.http_cache_storable(status.to_i, policy_fields(h), now.to_f) or return
        max_age, no_cache, immutable = stored
        @entries.clear if @entries.size >= MAX_ENTRIES && !@entries.key?(url)
        @entries[url] = Entry.new(
          status:    status,
          headers:   h,
          body:      body,
          stored_at: now,
          max_age:   max_age,
          no_cache:  no_cache,
          immutable: immutable,
          encoded:   encoded
        )
      end

      def revalidation_headers(entry)
        h = {}
        h['If-None-Match']     = entry.headers['etag']          if entry.headers['etag']
        h['If-Modified-Since'] = entry.headers['last-modified'] if entry.headers['last-modified']
        h
      end

      # RFC 9111 §4.3.4: a 304 that revalidates the entry stored for `url` refreshes it without replacing the body: its
      # header fields updated with the ones the 304 carries — a rotated ETag or Last-Modified what the next revalidation
      # sends — but for those it does not update (http_cache.rs `unrefreshed`: those describing the content it carries
      # none of, its cookies, the driver's own `x-csim-*`); and its freshness, no-cache and immutability read again off the
      # fields as they now are (a bare 304 keeps the stored Cache-Control, a new Date shortens an Expires). Where they now
      # forbid storing it — `no-store`, `private`, a Vary it cannot honour — it is dropped, though this request is still
      # answered from it. The fields are written as one new header map, never mutated in place: a thread reading the
      # entry's (an image load, a keepalive) iterates the one it took.
      def refresh(url, entry, new_headers)
        merged = ensure_lowercase(entry.headers)
        ensure_lowercase(new_headers).each do |k, v|
          merged[k] = v unless Native.http_cache_unrefreshed(k.to_s)
        end
        now = Time.now
        kept = Native.http_cache_refreshed(entry.status.to_i, policy_fields(merged), now.to_f)
        entry.headers   = merged
        entry.stored_at = now
        entry.max_age, entry.no_cache, entry.immutable = kept || [nil, false, false]
        @entries.delete(url) if kept.nil? && @entries[url].equal?(entry)
        entry
      end

      private

      # The fields of the lowercased `h` the engine's policy reads (http_cache.rs `storable`, `refreshed`, which answer
      # [max_age, no_cache, immutable], or nil where it may not be stored, or kept).
      def policy_fields(h) = POLICY_FIELDS.map {|name| h[name] }

      # Apps may return mixed-case header hashes on Rack 2; Rack 3 ships
      # lowercase. Normalise once per store/refresh so subsequent O(1)
      # lookups work either way without per-call linear scans — each value
      # one String, its fields combined (`combined`: a `no-store` given as
      # `['no-store']` is no-store, an ETag sent back as it was given). On
      # Rack 3 delegate to `Rack::Headers` (its `[]=` canonicalises keys);
      # Rack 2 has no such class — downcase keys into a plain Hash ourselves.
      # The `defined?` check is per-call because Rack loads after the gem
      # entry point requires this file.
      def ensure_lowercase(headers)
        out = defined?(::Rack::Headers) ? ::Rack::Headers.new : {}
        headers.each {|k, v| out[defined?(::Rack::Headers) ? k : k.to_s.downcase] = self.class.combined(v) }
        out
      end
    end
  end
end
