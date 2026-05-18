# frozen_string_literal: true

require 'json'

module Capybara
  module Simulated
    # Minimal source-map v3 decoder. Just enough for the stack-trace
    # rewriter to map `<asset URL>:<line>:<col>` (positions in the
    # served bundle, after EsmRewriter applied its column-only edits)
    # back to `<source file>:<line>:<col>` so failing-test traces point
    # at the original TS/JS instead of a 100k-char minified blob.
    #
    # EsmRewriter is line-preserving (every `import`/`export` rewrite
    # stays on its original line; `__csim_defineExport(...)` calls are
    # inlined alongside the originating declaration rather than appended
    # after the module body), so the only line-shift we have to apply
    # before lookup is the +1 wrapper line baked into bridge.js's
    # `globalThis.__csim_pending_factory = function (__exports) {\n` +
    # body + `\n}` wrap. Callers subtract that before calling `resolve`.
    #
    # Not handled:
    #   - `sections` (composite maps) — Vite/Rolldown don't emit them
    #   - `names` lookup — we don't need them for source-only resolution
    class Sourcemap
      Position = Struct.new(:source, :line, :column, keyword_init: true)

      BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      BASE64_LOOKUP = BASE64_CHARS.each_char.with_index.to_h.freeze

      def initialize(json)
        @sources = (json['sources'] || []).map(&:to_s)
        @source_root = json['sourceRoot'].to_s
        @segments_by_line = parse_mappings(json['mappings'].to_s)
      end

      # Returns the nearest mapping at-or-before (line, column). Line/col
      # are 1-based to match V8's stack-trace convention.
      def resolve(line, column)
        return nil if line < 1
        row = @segments_by_line[line - 1]
        return nil unless row && !row.empty?
        # Per-line row is a flat Integer array of stride 4: [gen_col,
        # source_idx, src_line, src_col, ...]. `bsearch_index` finds the
        # first segment whose gen_col is *strictly greater* than target;
        # the segment before that is the match.
        target = column - 1
        idx = (0...(row.length / 4)).bsearch {|i| row[i * 4] > target }
        match_i = (idx || row.length / 4) - 1
        return nil if match_i < 0
        base = match_i * 4
        source_idx = row[base + 1]
        return nil unless source_idx && @sources[source_idx]
        Position.new(
          source: full_source(@sources[source_idx]),
          line:   row[base + 2] + 1,
          column: row[base + 3] + 1
        )
      end

      private

      def full_source(name)
        return name if @source_root.empty?
        return name if name.start_with?('/', 'http://', 'https://')
        @source_root.end_with?('/') ? "#{@source_root}#{name}" : "#{@source_root}/#{name}"
      end

      # Decodes the `mappings` field into per-line flat Integer arrays.
      # Each generated line's row is a stride-4 array:
      # `[gen_col_0, source_idx_0, src_line_0, src_col_0, gen_col_1, ...]`.
      # Flat layout cuts allocation count ~4× vs an array of 4-tuples,
      # which matters for Vite bundles with 100k+ segments.
      #
      # Source-map v3 segments encode deltas against the previous segment
      # (gen_col resets per line; the others persist across lines).
      # Segments with fewer than 4 fields (rare — markers without source
      # info) get sentinel `nil`s in their source slots.
      def parse_mappings(mappings)
        lines = mappings.split(';', -1)
        out = Array.new(lines.length) { [] }
        source_idx = 0
        src_line   = 0
        src_col    = 0
        lines.each_with_index do |line, line_no|
          gen_col = 0
          row = out[line_no]
          line.split(',').each do |seg|
            next if seg.empty?
            fields = decode_vlqs(seg)
            gen_col += fields[0]
            if fields.length >= 4
              source_idx += fields[1]
              src_line   += fields[2]
              src_col    += fields[3]
              row.push(gen_col, source_idx, src_line, src_col)
            else
              row.push(gen_col, nil, nil, nil)
            end
          end
        end
        out
      end

      def decode_vlqs(segment)
        values = []
        value  = 0
        shift  = 0
        segment.each_char do |c|
          digit = BASE64_LOOKUP[c]
          raise ArgumentError, "invalid base64 char: #{c.inspect}" unless digit
          continuation = (digit & 0b100000) != 0
          digit &= 0b011111
          value |= digit << shift
          if continuation
            shift += 5
          else
            negative = (value & 1) == 1
            value >>= 1
            values << (negative ? -value : value)
            value  = 0
            shift  = 0
          end
        end
        values
      end
    end
  end
end
