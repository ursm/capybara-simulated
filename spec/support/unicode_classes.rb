# frozen_string_literal: true

# The Unicode general categories native has to agree with the ORACLE about — `\p{M}` for `font::zero_width`,
# `\p{L}` / `\p{N}` for `layout::hyphen_breaks_after`, whose classes are the oracle's `HYPHEN_BREAK_RE`.
#
# Native answers them from regex-syntax, which bakes in a UCD snapshot of its own; the oracle answers them
# from the JS ENGINE's tables. Those are two of the FOUR Unicode versions in this process — Ruby's and Rust
# std's are the others, and rustc 1.98 knows 4662 code points this V8 does not — and all four move
# independently. So the agreement is CHECKED rather than assumed: this enumerates the class from the driver's
# own engine, and `native_layout_text_spec` compares every range against what
# `Capybara::Simulated::Native.unicode_class_ranges` compiled in.
module UnicodeClasses
  CLASSES = %w[M L N].freeze

  # Every range of `\p{klass}`, asked of the session's own engine. ONE crossing walks the whole code space in
  # ~0.02s, so there is no reason to sample boundaries — and sampling was actively wrong here: probes derived
  # from the table under test vanish with the range they came from, which hid a DELETED range 60% of the time.
  def self.ranges_of(session, klass)
    session.evaluate_script(<<~JS)
      (() => {
        const RE = new RegExp('^' + String.fromCharCode(92) + 'p{#{klass}}$', 'u');  // a literal escape would be eaten by the heredoc
        const out = [];
        let start = null;
        for (let cp = 0; cp <= 0x10FFFF; cp++) {
          const hit = cp >= 0xD800 && cp <= 0xDFFF ? false : RE.test(String.fromCodePoint(cp));
          if (hit) { if (start === null) start = cp; }
          else if (start !== null) { out.push([start, cp - 1]); start = null; }
        }
        if (start !== null) out.push([start, 0x10FFFF]);
        return out;
      })()
    JS
  end
end
