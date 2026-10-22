# frozen_string_literal: true

require 'json'

require_relative 'sourcemap'

module Capybara
  module Simulated
    # Annotates a V8 stack-trace string with original-source positions
    # from the source map each frame's script names. Resolves once per frame,
    # caches loaded Sourcemap objects process-wide (built bundles are
    # fingerprinted; identical URL → identical map).
    #
    # Frames of a script that named no map (snapshot stubs, eval'd app inline
    # scripts, any URL that is no script the page ran) pass through unchanged.
    class StackResolver
      # Matches `(URL:LINE:COL)` inside V8 stack frames. URLs can contain
      # `:` (e.g. `:port`), so the URL class includes `:` and the engine
      # backtracks to find the trailing `:digits:digits)`. `file:` and
      # `csim-eval:` schemes are matched too because both appear in
      # snapshot-warmup frames where the host wraps eval'd content.
      FRAME_RE = /\((?<url>(?:https?:\/\/|file:\/\/|csim-eval:)[^\s()]+):(?<line>\d+):(?<col>\d+)\)/

      @@maps = {}
      @@lock = Mutex.new

      # The URL a script's text names in its last `sourceMappingURL` comment (`//# …` or the older `//@ …`), with only
      # white space after it; nil for none.
      def self.mapping_url(text)
        text = text.to_s
        at = text.rindex('sourceMappingURL=')
        at && text[[at - 8, 0].max..][/\/\/[#@]\s*sourceMappingURL=(\S+)\s*\z/, 1]
      end

      # Drop the fetched source maps (part of `Browser.clear_http_cache`).
      def self.clear
        @@lock.synchronize { @@maps.clear }
      end

      def initialize(browser)
        @browser = browser
      end

      # Returns the input stack/text with `→ source:line:col` appended to
      # every frame whose URL maps to a `.map`. If no frame resolves, the
      # input is returned unchanged.
      def annotate(text)
        return text unless text.is_a?(String) && !text.empty?
        text.gsub(FRAME_RE) {
          m = ::Regexp.last_match
          url  = m[:url]
          line = m[:line].to_i
          col  = m[:col].to_i
          resolved = resolve(url, line, col)
          resolved ? "#{m[0]} → #{resolved}" : m[0]
        }
      end

      private

      def resolve(url, line, col)
        map = load_map(url)
        return nil unless map
        pos = map.resolve(line, col)
        return nil unless pos
        "#{pos.source}:#{pos.line}:#{pos.column}"
      end

      # The map a frame's script named in its `sourceMappingURL` comment as it ran (`Browser#note_source_map`) — kept by
      # that map's URL, resolved against the script's — or nil for a script that named none. Nothing else is ever
      # requested, as a browser guesses no `<url>.map`: a frame's URL may be its DOCUMENT's (an inline script's), which a
      # request would run the app's action for again.
      def load_map(url)
        directive = @browser.source_map_of(url)
        return nil unless directive
        map_url = directive.start_with?('data:') ? directive : @browser.resolve_against(directive, url)
        return @@maps[map_url] if @@maps.key?(map_url)
        @@lock.synchronize {
          return @@maps[map_url] if @@maps.key?(map_url)
          @@maps[map_url] = build_map(map_url)
        }
      end

      # …a data: one decoded, any other fetched.
      def build_map(map_url)
        body = map_url.start_with?('data:') ? decode_data_url(map_url) : @browser.rack_fetch_body(map_url)
        return nil unless body
        Sourcemap.new(JSON.parse(body))
      rescue JSON::ParserError, ArgumentError
        nil
      end

      # A source map given inline, by Fetch's data: URL processor (the engine's): its body, or nil.
      def decode_data_url(uri) = Native.data_url(uri)&.last
    end
  end
end
