// The Unicode general categories the ORACLE asks a regex for, and that native therefore has to answer the
// same way: `\p{M}`, which `font::zero_width` needs to decide whether a character at or above U+0300 is
// zero-width, and `\p{L}` / `\p{N}`, which `layout::hyphen_breaks_after` needs because the oracle's
// `HYPHEN_BREAK_RE` spells its classes that way.
//
// The classes come from regex-syntax — the SAME regex the oracle writes, parsed rather than reimplemented —
// and NOT from Rust std's `char::is_alphabetic` / `is_numeric`. FOUR Unicode versions live in this process
// (the engine's, Ruby's, Rust std's and now regex-syntax's) and they move independently: rustc 1.98 knows
// 4662 code points this V8 does not, and a native `is_letter` built on it broke a line after a hyphen that
// the oracle kept whole, with the answer depending on the toolchain the extension happened to be built with.
// `char::is_alphanumeric` is wrong for a second reason — it is Alphabetic ∪ N, which reads a COMBINING MARK
// as a letter where `\p{L}` does not.
//
// WHAT THIS PINS US TO, plainly: the classes are now regex-syntax's UCD snapshot (16.0.0 as vendored), not
// the engine's. They agree today — every range, all three classes — and `class_ranges` below exists so that
// `spec/native_layout_text_spec.rb` can keep proving it against the engine's own answer. But when the engine
// picks up a Unicode release first, there is no local fix: the two disagree on every code point the release
// added (4699 of them for Unicode 17), and until regex-syntax ships a matching snapshot native LAYS OUT
// THOSE CHARACTERS DIFFERENTLY FROM THE ORACLE — a red spec is the symptom, not the whole cost. The
// alternative (generating the tables from the engine, as this file used to) had no such wait but carried 864
// lines of table; the trade was made deliberately.
use regex_syntax::hir::{Class, HirKind};
use std::sync::LazyLock;

// One static per class, so the pattern and the table it fills are named together exactly once: writing the
// pair out at each call site let a typo pick the wrong class, and — because the table is built on FIRST use —
// which answer you got would then depend on whether layout or the drift check ran first.
static MARKS: LazyLock<Vec<(u32, u32)>> = LazyLock::new(|| ranges(r"\p{M}"));
static LETTERS: LazyLock<Vec<(u32, u32)>> = LazyLock::new(|| ranges(r"\p{L}"));
static NUMBERS: LazyLock<Vec<(u32, u32)>> = LazyLock::new(|| ranges(r"\p{N}"));

// A class's code-point ranges: ascending and disjoint, which is what `in_ranges`' binary search needs, and
// non-adjacent besides — regex-syntax canonicalises a `ClassUnicode` on construction (`Interval::canonicalize`
// sorts and merges), so both hold by construction rather than by inspection.
fn ranges(pattern: &'static str) -> Vec<(u32, u32)> {
    // The pattern is a literal above, so a failure here means the crate was built without
    // `regex-syntax/unicode-gencat` — a build misconfiguration, not an input a caller can recover from. `init`
    // forces all three so that it lands at `require`, where magnus catches the unwind and Ruby reports the
    // message with a backtrace (measured: a `fatal` naming the missing feature). Left to the LAYOUT path it
    // would instead unwind through a V8 `extern "C"` callback, which aborts the process with no Ruby frame.
    let hir = regex_syntax::parse(pattern)
        .unwrap_or_else(|e| panic!("csim_native needs regex-syntax/unicode-gencat: {pattern} → {e}"));
    match hir.into_kind() {
        HirKind::Class(Class::Unicode(cu)) => cu.iter().map(|r| (r.start() as u32, r.end() as u32)).collect(),
        other => panic!("{pattern} is not a unicode class: {other:?}"),
    }
}

// Build all three now, while a panic is still a load-time failure the caller can read. ~4.4µs.
pub(crate) fn init() {
    LazyLock::force(&MARKS);
    LazyLock::force(&LETTERS);
    LazyLock::force(&NUMBERS);
}

pub(crate) fn is_combining_mark(cp: u32) -> bool {
    in_ranges(&MARKS, cp)
}
pub(crate) fn is_letter(cp: u32) -> bool {
    in_ranges(&LETTERS, cp)
}
pub(crate) fn is_number(cp: u32) -> bool {
    in_ranges(&NUMBERS, cp)
}

fn in_ranges(table: &[(u32, u32)], cp: u32) -> bool {
    table
        .binary_search_by(|&(lo, hi)| {
            if cp < lo {
                std::cmp::Ordering::Greater
            } else if cp > hi {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

// The tables themselves, for the drift check: `Capybara::Simulated::Native.unicode_class_ranges('L')` answers
// what regex-syntax compiled in, and the spec compares it to what the ORACLE's own engine answers for
// `/^\p{L}$/u`. It hands back the SAME statics the layout path reads, so what the spec proves is what layout
// uses. This is a seam for a production invariant, not a test fixture — nothing else in the driver reads it.
pub(crate) fn class_ranges(ruby: &magnus::Ruby, klass: String) -> Result<Vec<(u32, u32)>, magnus::Error> {
    let table: &[(u32, u32)] = match klass.as_str() {
        "M" => &MARKS,
        "L" => &LETTERS,
        "N" => &NUMBERS,
        other => {
            return Err(magnus::Error::new(
                ruby.exception_arg_error(),
                format!("unknown general category {other:?} (M, L or N)"),
            ));
        }
    };
    Ok(table.to_vec())
}
