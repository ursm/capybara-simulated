# frozen_string_literal: true

require 'base64'
require 'json'

require_relative 'sourcemap'

module Capybara
  module Simulated
    # Annotates a V8 stack-trace string with original-source positions
    # from each frame's `.map` companion file. Resolves once per frame,
    # caches loaded Sourcemap objects process-wide (built bundles are
    # fingerprinted; identical URL → identical map).
    #
    # Frames whose URL has no `.map` (snapshot stubs, eval'd app inline
    # scripts) pass through unchanged.
    #
    # The V8-line → bundle-line adjustment is `-1` because every ESM
    # module is eval'd inside a one-line wrapper
    # (`globalThis.__csim_pending_factory = function (__exports) {\n…\n}`).
    # EsmRewriter is line-preserving for everything else, so the wrapper
    # offset is the entire correction.
    #
    # Column drift caveat: when an `import` / `export` rewrite expands
    # on the same line as later body code (the common minified case
    # where all imports + body live on line 1), the column of body
    # tokens shifts to the right in the rewritten source. We resolve
    # using the post-rewrite column verbatim, which usually still lands
    # on the right sourcemap segment because Vite-style bundles put the
    # body on its own line below the import header. Targeted column
    # adjustment per rewrite would tighten this up but isn't needed for
    # the workloads we currently care about.
    class StackResolver
      WRAPPER_LINE_OFFSET = 1

      # Matches `(URL:LINE:COL)` inside V8 stack frames. URLs can contain
      # `:` (e.g. `:port`), so the URL class includes `:` and the engine
      # backtracks to find the trailing `:digits:digits)`. `file:` and
      # `csim-eval:` schemes are matched too because both appear in
      # snapshot-warmup frames where the host wraps eval'd content.
      FRAME_RE = /\((?<url>(?:https?:\/\/|file:\/\/|csim-eval:)[^\s()]+):(?<line>\d+):(?<col>\d+)\)/

      @@maps = {}
      @@lock = Mutex.new

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
        pos = map.resolve(line - WRAPPER_LINE_OFFSET, col)
        return nil unless pos
        "#{pos.source}:#{pos.line}:#{pos.column}"
      end

      def load_map(url)
        return @@maps[url] if @@maps.key?(url)
        @@lock.synchronize {
          return @@maps[url] if @@maps.key?(url)
          @@maps[url] = build_map(url)
        }
      end

      def build_map(url)
        body = fetch_map_body(url)
        return nil unless body
        Sourcemap.new(JSON.parse(body))
      rescue JSON::ParserError, ArgumentError
        nil
      end

      # Tries the conventional `<url>.map` location; falls back to the
      # inline `sourceMappingURL` directive at the bottom of the bundle
      # if the sibling `.map` 404s. data: URLs (inline base64 maps) are
      # also supported via `sourceMappingURL`.
      def fetch_map_body(url)
        body = @browser.rack_fetch_body("#{url}.map")
        return body if body
        bundle = @browser.rack_fetch_body(url)
        return nil unless bundle
        directive = bundle[/\/\/[#@]\s*sourceMappingURL=([^\s]+)\s*\z/, 1]
        return nil unless directive
        if directive.start_with?('data:')
          decode_data_url(directive)
        else
          @browser.rack_fetch_body(@browser.resolve_against(directive, url))
        end
      end

      def decode_data_url(uri)
        return nil unless uri =~ %r{\Adata:application/json(?:;charset=[^;,]+)?;base64,(.+)\z}m
        Base64.decode64(::Regexp.last_match(1))
      end
    end
  end
end
