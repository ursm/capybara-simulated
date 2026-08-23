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
    #   - Responses with `Cache-Control: private` — per-user responses that a
    #     SHARED cache MUST NOT store (RFC 9111 §5.2.2.7). This cache is
    #     process-wide and shared across test sessions, so it is a shared
    #     cache for that purpose. (Forem's `/async_info/base_data` etc. send
    #     `max-age=0, private`; storing them only wastes memory on data that
    #     is always revalidated.)
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
    # No Mutex: MRI's Hash `[]`/`[]=` are atomic under the GVL. Concurrent access is
    # real — async image loads (and keepalive fetches) run `rack_fetch` on background
    # threads while the main thread fetches too — but every operation here is a single
    # GVL-atomic Hash read or write of an immutable-once-built Entry, so the worst a
    # racing reader sees is a partial `stored_at`/`max_age` pair on `refresh`: freshness
    # computed against a transient mix, never a corrupted structure.
    class AssetCache
      Entry = Struct.new(:status, :headers, :body, :stored_at, :max_age, :no_cache, :immutable, keyword_init: true) do
        # `must-revalidate` (RFC 9111 §5.2.2.2) only forbids reusing a
        # response *once it has become stale* without revalidation — it
        # does NOT force revalidation while the entry is still fresh, and
        # this cache never serves a stale entry without revalidating
        # anyway (lookup falls through to a conditional re-dispatch). So
        # `must-revalidate` has no effect on freshness here. Only
        # `no-cache` (§5.2.2.4), which requires validation before EVERY
        # use, blocks a fresh entry. Conflating the two made Vite/Rails
        # assets (`max-age=2419200, must-revalidate`) revalidate on every
        # fetch instead of being served fresh like a real browser does.
        def fresh?(now = Time.now)
          return false if no_cache
          # `max-age=0` (or absent) means the response is stale on arrival —
          # a cache MUST revalidate before reuse (RFC 9111 §5.2.1.1). Ruby's
          # `0` is truthy, so the value must be guarded explicitly; without
          # `positive?`, a `max-age=0, must-revalidate` response (e.g. Forem's
          # per-user `/async_info/base_data`, `/notifications/counts`) would be
          # treated as fresh and served stale instead of revalidated.
          return false unless max_age&.positive?
          (now - stored_at) < max_age
        end
      end

      # RFC 9111 §3: status codes cacheable by default.
      # Statuses we store. 301/308 (permanent redirects) are cacheable by default; 302/307
      # (temporary) are cacheable too but only ever served fresh with EXPLICIT freshness — they
      # are excluded from HEURISTIC_STATUSES below, and a 302/307 with neither explicit freshness
      # nor a validator is dropped by `store`. Storing them lets a cached redirect be followed
      # from the cache (request-cache only-if-cached/force-cache).
      CACHEABLE_STATUSES = [200, 203, 204, 206, 300, 301, 302, 307, 308, 404, 405, 410, 414, 501].freeze
      # Statuses eligible for HEURISTIC freshness (RFC 9111 §4.2.2 — "cacheable by default").
      # 302/307 are NOT here: a temporary redirect is served fresh only with explicit freshness,
      # never a Last-Modified-derived heuristic (which would risk serving it stale).
      HEURISTIC_STATUSES = [200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501].freeze

      # `Vary` fields we can safely ignore because Simulated never sends
      # the corresponding request header — the cached "no value" variant
      # is always applicable. `Accept-Encoding` is the common one Rails
      # adds to sprockets-served assets.
      SAFE_VARY_FIELDS = %w[accept-encoding].freeze

      # Immutable entries live for the PROCESS now (they survive every reset), and a long app
      # suite mints fresh content-addressed URLs per example (Discourse's per-test themes and
      # colour schemes → new `/theme-javascripts/<sha1>.js` / `/stylesheets/*_<hash>.css`), so
      # the map is bounded the way `@@asset_src` is: wipe and restart when it fills.
      MAX_ENTRIES = 4096

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

      def store(url, status, headers, body)
        return unless CACHEABLE_STATUSES.include?(status)
        h = ensure_lowercase(headers)
        return unless vary_compatible?(h['vary'])
        cc = parse_cache_control(h['cache-control'])
        # Honour the server's explicit directives only (RFC 9111) — no
        # URL-shape heuristic. `no-store` MUST NOT be stored (§5.2.2.5),
        # full stop; whether a URL "looks fingerprinted" is a guess that
        # can misfire and serve a genuinely no-store response stale.
        return if cc[:no_store]
        # `private` is a per-user response a shared cache MUST NOT store
        # (§5.2.2.7); this process-wide cache is shared across sessions.
        return if cc[:private]
        max_age = freshness_seconds(cc, h, heuristic: HEURISTIC_STATUSES.include?(status))
        # Nothing useful to cache without a freshness signal or a
        # validator to revalidate against.
        return if max_age.nil? && h['etag'].nil? && h['last-modified'].nil?
        @entries.clear if @entries.size >= MAX_ENTRIES && !@entries.key?(url)
        @entries[url] = Entry.new(
          status:    status,
          headers:   h,
          body:      body,
          stored_at: Time.now,
          max_age:   max_age,
          no_cache:  cc[:no_cache],
          immutable: cc[:immutable] == true
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
        entry.stored_at = Time.now
        entry.max_age   = freshness_seconds(cc, h, heuristic: HEURISTIC_STATUSES.include?(entry.status)) || entry.max_age
        # RFC 9111 §4.3.4: a 304 UPDATES stored header fields with the ones
        # it carries; it does not delete them. A bare 304 (no Cache-Control —
        # the common ETag / Last-Modified revalidation) must therefore PRESERVE
        # the stored no-cache flag, otherwise a `no-cache` resource would stop
        # revalidating after its first 304 and start serving fresh. Only a 304
        # that actually resends Cache-Control re-derives it.
        entry.no_cache  = h['cache-control'] ? cc[:no_cache] : entry.no_cache
        entry
      end

      private

      def freshness_seconds(cc, headers, heuristic: true)
        explicit = cc[:max_age] || expires_to_max_age(headers['expires'], headers['date'])
        explicit || (heuristic ? heuristic_freshness(headers) : nil)
      end

      # RFC 9111 §4.2.2: a response with no explicit freshness (no max-age, no
      # Expires) but a `Last-Modified` MAY be assigned a heuristic lifetime; the
      # common browser choice is 10% of (now − Last-Modified), and browsers cap
      # it (an old `Last-Modified` shouldn't grant years of freshness) — we cap
      # at one day. Without this, a response carrying only `Last-Modified` is
      # revalidated on every fetch, which is what a real browser AVOIDS for e.g.
      # Discourse's content-hashed `/assets/*.js` (shipped with `Last-Modified`
      # and no `Cache-Control`). In the volatile asset cache, cross-visit
      # staleness is bounded by `clear_volatile` dropping non-immutable entries
      # per visit; Browser's cross-visit `@@asset_src` cache has its own
      # argument (it only holds content-stable assets at content-hashed URLs).
      HEURISTIC_FRESHNESS_CAP = 24 * 60 * 60

      def heuristic_freshness(headers)
        lm = headers['last-modified'] or return nil
        t  = (Time.httpdate(lm) rescue nil) or return nil
        age = Time.now - t
        age.positive? ? [(age * 0.1).to_i, HEURISTIC_FRESHNESS_CAP].min : nil
      end

      def vary_compatible?(vary)
        return true unless vary
        fields = vary.to_s.downcase.split(',').map(&:strip)
        return false if fields.include?('*')
        (fields - SAFE_VARY_FIELDS).empty?
      end

      # Apps may return mixed-case header hashes on Rack 2; Rack 3 ships
      # lowercase. Normalise once per store/refresh so subsequent O(1)
      # lookups work either way without per-call linear scans. On Rack 3
      # delegate to `Rack::Headers` (its `[]=` canonicalises keys); Rack
      # 2 has no such class — downcase keys into a plain Hash ourselves.
      # The `defined?` check is per-call because Rack loads after the gem
      # entry point requires this file.
      def ensure_lowercase(headers)
        if defined?(::Rack::Headers)
          return headers if headers.is_a?(::Rack::Headers)
          out = ::Rack::Headers.new
          headers.each {|k, v| out[k] = v }
          out
        else
          out = {}
          headers.each {|k, v| out[k.to_s.downcase] = v }
          out
        end
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
          when 'private'          then out[:private]          = true
          when 'immutable'        then out[:immutable]        = true
          when 'max-age'          then out[:max_age]          = m[:val].to_i if m[:val]
          # `s-maxage` applies to SHARED caches only (RFC 9111 §5.2.2.10); a
          # browser is a private cache and MUST ignore it — otherwise an
          # `s-maxage=N` response with no `max-age` would be served fresh for
          # N instead of revalidated, diverging from a real browser.
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
