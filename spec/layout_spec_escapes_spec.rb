# frozen_string_literal: true

# A layout spec says what it is about in a STRING of markup, and twice now a shape has been written with a
# single-quoted `\t` — a backslash and a `t`, not a tab. Ruby does not interpret an escape in single quotes,
# so the shape silently becomes a different one: the example goes on passing while it tests nothing it claims
# to (measured — the soft-hyphen example for the tabbed-run break passed with the fix reverted, and an
# inline-atomic example asserted a forced break it did not contain).
#
# Nothing else catches it. The harness compares the two engines on whatever markup it is handed, so both
# agree on the wrong shape; the parity is real, the coverage is not. It is mechanical to check, so it is
# checked here rather than remembered.
RSpec.describe 'layout spec markup' do
  # Every escape Ruby interprets in a double-quoted string and not in a single-quoted one. `\u` is the
  # likeliest remaining trap after `\t` — an NBSP written `'\u00a0'` in a line-breaking spec is a literal
  # backslash-u, and the shape becomes one about the letter `u`.
  ESCAPE_IN_SINGLE_QUOTES = /'[^']*\\[tnrfe0uxsavb][^']*'/
  # Every spec, not a list of name prefixes — but only the lines that hand a string to a layout HELPER. A
  # spec that embeds JS in Ruby writes `'…\\n'` on purpose (the escape is for the JS string, not the Ruby
  # one), so the file it lives in is no guide; what the shape is FOR is.
  HELPER = /\b(?:expect_parity|expect_bail|expect_walk_declines|expect_declined_x|expect_native_\w+|run_shadow|shadow)\(/
  SPECS = Dir[File.expand_path('*_spec.rb', __dir__)].reject {|f| f == __FILE__ }   # …this file TALKS about it

  it 'writes an escape in a shape only where Ruby interprets it' do
    offenders = SPECS.flat_map {|f|
      # A spec can write a fixture of its own into this directory for the length of an example
      # (`ci_rspec_spec`), which a parallel run may delete between the glob and the read: gone, it holds no shape.
      lines = begin
        File.readlines(f)
      rescue Errno::ENOENT
        next []
      end
      lines.each_with_index.filter_map {|line, i|
        next if line.lstrip.start_with?('#')                    # a comment may SAY it; only code is a shape
        next unless line.match?(HELPER) && line.match?(ESCAPE_IN_SINGLE_QUOTES)

        "#{File.basename(f)}:#{i + 1}: #{line.strip}"
      }
    }
    expect(offenders).to be_empty, <<~MSG
      A single-quoted string holds an escape Ruby will not interpret — the shape is not the one the
      example means. Use %(…) or "…" instead:
      #{offenders.join("\n")}
    MSG
  end
end
