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
  # Every spec, not a list of name prefixes — but only the lines that hold a layout SHAPE. A spec that
  # embeds JS in Ruby writes `'…\\n'` on purpose (the escape is for the JS string, not the Ruby one), so
  # the file it lives in is no guide; what the shape is FOR is. Two ways to be one, because a shape is not
  # always written on the line that hands it over: by the HELPER it is passed to, and — for the shapes that
  # live in a hash or array literal and reach the helper through a block parameter, which is how
  # `display_contents_spec` and every table-driven example write them — by being MARKUP itself. Keying only
  # on the helper name made every such table invisible to this guard.
  HELPER = /\b(?:expect_parity|expect_bail|expect_walk_declines|expect_declined_x|expect_native_\w+|run_shadow|shadow|session_for)\(/
  MARKUP = /'[^']*<[a-z]+[ >][^']*'/
  # …and a heredoc is not the subject at all: quoting does not apply inside one, so `\\n` there is the
  # author writing a backslash-n for a JS string on purpose, not a Ruby escape that failed to interpret.
  # It suppresses exactly one line across the whole spec tree today (`inner_text_breaks_spec`, a JS
  # `innerHTML =` inside an HTML heredoc) — a small number for a rule that has to be right, since without
  # it every embedded script that writes markup becomes a false offender and the guard gets turned off.
  # The `-`/`~` is REQUIRED: a bare `<<NAME` is legal Ruby but indistinguishable from `list << CONST`, and
  # mistaking that for an opener would silently swallow the rest of the file — a guard that scans nothing.
  # The same swallow is still reachable by writing `<<~NAME` INSIDE a string on a code line; no spec does,
  # and the fix would be a Ruby lexer, so it is written down here instead of guessed at in code.
  HEREDOC_OPEN = /<<[-~]([A-Z_]+)\b/
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
      # …one line may open SEVERAL (`foo(<<~A, <<~B)`), and they close in the order they were opened.
      open_heredocs = []
      lines.each_with_index.filter_map {|line, i|
        if open_heredocs.any?
          open_heredocs.shift if line.strip == open_heredocs.first
          next
        end
        next if line.lstrip.start_with?('#')                    # a comment may SAY it; only code is a shape

        # …AFTER the comment check: a commented-out `<<~HTML` is no opener, and taking it for one would
        # skip every line until something happened to strip to `HTML` — most likely the rest of the file.
        open_heredocs = line.scan(HEREDOC_OPEN).flatten          # …`match?` sets no `$~`
        next unless (line.match?(HELPER) || line.match?(MARKUP)) && line.match?(ESCAPE_IN_SINGLE_QUOTES)

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
