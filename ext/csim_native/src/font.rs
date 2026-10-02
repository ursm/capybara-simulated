// Native text metrics via fontations (skrifa / read-fonts) — the pure-Rust font stack Chrome and Servo
// use. A font file is parsed ONCE into a small advance table (printable-ASCII em-fractions + their
// mean, exactly the shape the host's `font_advance_table` builds, so run widths match bit-for-bit), and
// native inline layout (mod layout, stage L2) measures a run's width IN-PROCESS — no per-run V8
// crossing (the granularity that made a per-call __dom.measureRun op a wash; see perf_dead_ends).
//
// PARITY is the contract: `measure_run` reproduces layout.js `measureRun`/`unitOf` exactly, in f64 (JS
// Numbers are f64) — the ASCII table, NBSP-as-space, the CJK/fullwidth full-em fallback, the zero-width
// classes, ZWJ joining, astral full-em, and letter/word spacing. It returns None only for a run holding a TAB
// (the advance is the BLOCK's tab stops, not the run's); the caller declines such a block to JS. Every other
// character is decidable, the combining marks (the oracle's `\p{M}`) through `unicode.rs`. Line HEIGHT is not computed here — JS pushes
// the resolved line-height px, so no hhea/vertical-metric parity is needed for L2.

use std::cell::RefCell;
use std::collections::HashMap;

use skrifa::instance::{LocationRef, Size};
use skrifa::metrics::GlyphMetrics;
use skrifa::{FontRef, MetadataProvider};

// One font's measured advances: printable ASCII (32..=126) as em-fractions (advance units / units-per-em,
// matching the host reader), indexed by byte; None where the font maps no glyph or a non-positive
// advance (the JS side answers those with `avg`). `avg` is the mean of the present ASCII advances.
pub(crate) struct FontMetrics {
    ascii: [Option<f64>; 128],
    avg: f64,
    // A `unicode-range` SPLIT (`registerFontStack`): the faces a run's characters pick from, in order — the first that
    // covers a character measures it, and one none covers is this face's own (layout.js `pickCharCand`). None for a
    // single face.
    split: Option<Vec<StackMember>>,
}

// One face of a `unicode-range` split: its registered handle, the ranges it covers (None: every code point), and its
// vertical metrics in ems — None where its table carries none (the JS model's `t.asc == null`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StackMember {
    pub(crate) ranges: Option<Vec<(u32, u32)>>,
    pub(crate) handle: i32,
    pub(crate) vertical: Option<VerticalMetrics>,
}

// A face's ascent, descent and line gap, in ems.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct VerticalMetrics {
    pub(crate) asc: f64,
    pub(crate) desc: f64,
    pub(crate) gap: f64,
}

impl StackMember {
    fn covers(&self, cp: u32) -> bool {
        self.ranges.as_ref().is_none_or(|r| r.iter().any(|&(lo, hi)| (lo..=hi).contains(&cp)))
    }
}

// The code points of a UTF-16 run, a lone surrogate standing for itself (JavaScript's `codePointAt`).
fn code_points(text: &[u16]) -> impl Iterator<Item = u32> + '_ {
    char::decode_utf16(text.iter().copied()).map(|r| r.map_or_else(|e| e.unpaired_surrogate() as u32, |c| c as u32))
}

impl FontMetrics {
    // The advance of its `0`, in ems — what a `ch` is — else its mean advance, as the JS model's `chFactor` falls back.
    pub(crate) fn zero_advance(&self) -> f64 {
        self.ascii[b'0' as usize].filter(|&a| a > 0.0).unwrap_or(self.avg)
    }
    // The face of a split that a character takes — the first member covering it — or None, where it takes this face's
    // own (no split, or no member covers it).
    fn member_for(&self, cp: u32) -> Option<&StackMember> {
        self.split.as_ref()?.iter().find(|m| m.covers(cp))
    }
    // Whether this face splits a run's characters across faces (`registerFontStack`).
    pub(crate) fn is_split(&self) -> bool {
        self.split.is_some()
    }
    // The line box a run of `text` needs in a split face, as the ascent and descent around its baseline: the deepest of
    // each among the faces its characters select, every one laid out as a face of its own would be — its box centred in
    // `fixed_lh` (a `line-height` that is not `normal`), else in its own box and line gap (layout.js `runFaceVMax`). A
    // character no member covers takes `primary`, the face the run's style resolves to. None when nothing on the run
    // has vertical metrics, or the face does not split.
    pub(crate) fn run_vmax(&self, text: &[u16], size: f64, fixed_lh: Option<f64>, primary: Option<VerticalMetrics>) -> Option<(f64, f64)> {
        self.split.as_ref()?;
        let round = crate::walk::js_round;
        let mut seen: Vec<VerticalMetrics> = Vec::new();
        let mut most: Option<(f64, f64)> = None;
        for cp in code_points(text) {
            let Some(v) = self.member_for(cp).map_or(primary, |m| m.vertical) else { continue };
            if seen.contains(&v) {
                continue;
            }
            seen.push(v);
            let bx = round(v.asc * size) + round(v.desc * size);
            let lh = fixed_lh.unwrap_or_else(|| bx + round(v.gap * size));
            let asc = ((lh - bx) / 2.0).floor() + round(v.asc * size);
            let (a, d) = most.unwrap_or((0.0, 0.0));
            most = Some((a.max(asc), d.max(lh - asc)));
        }
        most
    }
    // Build from font file bytes (SFNT: TTF/OTF; WOFF/WOFF2 decoded host-side). None when the file can't
    // be parsed, has no units-per-em, or maps no printable ASCII with a positive advance.
    fn from_bytes(bytes: &[u8]) -> Option<FontMetrics> {
        let font = FontRef::new(bytes).ok()?;
        let upem = font.metrics(Size::unscaled(), LocationRef::default()).units_per_em as f64;
        if upem <= 0.0 {
            return None;
        }
        let charmap = font.charmap();
        let gm: GlyphMetrics = font.glyph_metrics(Size::unscaled(), LocationRef::default());
        let mut ascii = [None; 128];
        let mut total = 0.0;
        let mut count = 0u32;
        for cp in 32u32..=126 {
            let ch = char::from_u32(cp).unwrap();
            let Some(gid) = charmap.map(ch) else { continue };
            let Some(adv) = gm.advance_width(gid) else { continue };
            let units = adv as f64;
            if units <= 0.0 {
                continue;
            }
            let px = units / upem;
            ascii[cp as usize] = Some(px);
            total += px;
            count += 1;
        }
        if count == 0 {
            return None;
        }
        Some(FontMetrics { ascii, avg: total / count as f64, split: None })
    }

    // Width (px) of a UTF-16 run at `size` px with letter/word spacing, exactly as layout.js measureRun does.
    // Every character is measurable — the TAB was the last one that was not, and it is measured here now that
    // the pen reaches it. So this never answers None itself; it stays an `Option` because its one caller
    // (`measure_at`) reaches it through `with_font`, which answers None for a font handle that is not
    // registered, and the two Nones are indistinguishable to the caller anyway.
    // Bit-parity vs JS measureRun was validated over ~667k calls (perf log 2026-09-09) on the ASCII-and-Latin
    // input this accepted then; the classes admitted since (wide characters, combining marks, tabs) are held
    // to the box-level parity the shadow harness checks, not to that measurement.
    // `from` is the pen's distance from the block's content edge and `tab_px` / `tab_min` the stop pair a TAB
    // advances to (see `Run::tab_px`); every other character ignores all three.
    pub(crate) fn measure_run(&self, text: &[u16], size: f64, ls: f64, ws: f64, from: f64, tab_px: f64, tab_min: f64) -> f64 {
        let spaced = ls != 0.0 || ws != 0.0;
        let mut units = 0.0f64;
        let mut spacing = 0.0f64;
        let mut prev: i64 = -1;
        for cp in code_points(text) {
            if cp == 0x09 {
                // The oracle's `tabAdvance`, on the pen this measure has reached: the distance to the next
                // stop, or to the one AFTER it where that is nearer than half a space (Blink's `Font::TabWidth`
                // — `tab-size: 20px` after 19.2px of text lands at 40, after 9.6px at 20). Stops are counted
                // from the block's content edge, which `from` is measured from, and `text-indent` does not
                // move them. It joins `spacing` rather than `units` because it is already a px advance.
                // …and `tab_px` is already final: a `tab-size` that resolved to zero took the BLOCK's
                // letter-spacing as its stop spacing back in `tabStopOf`, so nothing here asks this RUN
                // anything. Zero means there is no stop to reach and a tab advances nothing.
                spacing += if tab_px > 0.0 {
                    let pen = from + units * size + spacing;
                    let into = pen - (pen / tab_px + 1e-9).floor() * tab_px;
                    let dist = tab_px - into;
                    // `<` against a half-open epsilon, as the oracle writes it: Blink compares in float32, so
                    // a stop exactly `tab_min` away counts as too near.
                    if dist < tab_min + 1e-6 { dist + tab_px } else { dist }
                } else {
                    0.0
                };
                prev = cp as i64;
                continue;
            }
            units += match self.member_for(cp) {
                Some(m) => with_font(m.handle, |fm| unit_of(cp, prev, fm)).unwrap_or_else(|| unit_of(cp, prev, self)),
                None => unit_of(cp, prev, self),
            };
            if spaced && takes_spacing(cp, prev) {
                spacing += ls + if cp == 0x20 || cp == 0x00A0 { ws } else { 0.0 };
            }
            prev = cp as i64;
        }
        units * size + spacing
    }
}

// layout.js isWideChar: CJK / fullwidth / Hangul are full-em in every font that has them — and, since the
// break units follow the same classifier (`break_unit_len`), the ONE definition both sides read. BMP only,
// exactly as the oracle's is: an astral code point is full-em there but never its own break unit.
pub(crate) fn is_wide_char(cp: u32) -> bool {
    // The oracle's own gate (`u >= 0x1100 && isWideChar(...)`): every ASCII character answers on one compare
    // instead of walking seven ranges, and this is asked per WORD of every line layout now, not per run.
    if cp < 0x1100 {
        return false;
    }
    (0x1100..=0x115F).contains(&cp)
        || (0x2E80..=0xA4CF).contains(&cp)
        || (0xAC00..=0xD7A3).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
        || (0xFE30..=0xFE6F).contains(&cp)
        || (0xFF00..=0xFF60).contains(&cp)
        || (0xFFE0..=0xFFE6).contains(&cp)
}

// layout.js zeroWidth. Every code point is decidable: the ranges below from structure, and the rest from the
// oracle's own `\p{M}` (see the last arm). This used to answer `None` where a combining-mark test was needed
// and the whole layout pass fell back to JS — which is why `unicode.rs` exists.
fn zero_width(cp: u32) -> bool {
    if cp < 0x20 {
        return true;
    }
    if cp < 0x7F {
        return false;
    }
    if cp <= 0x9F {
        return true;
    }
    if cp < 0x300 {
        return cp == 0xAD;
    }
    if cp == 0xFEFF || cp == 0xFFFC || cp == 0x200E || cp == 0x200F {
        return true;
    }
    if (0x200B..=0x200D).contains(&cp) {
        return true;
    }
    if (0x202A..=0x202E).contains(&cp) {
        return true;
    }
    if (0xFE00..=0xFE0F).contains(&cp) {
        return true;
    }
    if (0xE0100..=0xE01EF).contains(&cp) {
        return true;
    }
    // …and the one question structure cannot answer — is this a COMBINING MARK? — is answered by the oracle's
    // own `\p{M}`, parsed out of the same regex (`unicode.rs`). So every character is decidable now: a CJK
    // run, an em space, a dash, an emoji no longer reach an undecidable arm and take the whole pass with them.
    crate::unicode::is_combining_mark(cp)
}

// layout.js unitOf: one character's advance in em-fractions — none for a pictograph a ZWJ joins to the one before it
// (an emoji ZWJ sequence draws as one glyph: UAX #29 GB11), where a letter after one keeps its own (Chrome: `abc‍def`
// is 57.6 in 16px monospace).
fn unit_of(cp: u32, prev: i64, fm: &FontMetrics) -> f64 {
    if joined(cp, prev) || zero_width(cp) {
        return 0.0;
    }
    if cp <= 0xFFFF {
        if (0x20..0x7F).contains(&cp) {
            if let Some(a) = fm.ascii[cp as usize] {
                return a;
            }
        }
        if cp == 0x00A0 {
            return fm.ascii[0x20].unwrap_or(fm.avg);
        }
        return if is_wide_char(cp) { 1.0 } else { fm.avg };
    }
    1.0
}

// layout.js takesSpacing: once per grapheme, never on a pictograph a ZWJ joins, never on a zero-width character.
fn takes_spacing(cp: u32, prev: i64) -> bool {
    !joined(cp, prev) && !zero_width(cp)
}
// Whether `cp` is joined into the cluster before it by the ZERO WIDTH JOINER `prev` — a pictograph after one (GB11).
fn joined(cp: u32, prev: i64) -> bool {
    prev == 0x200D && crate::unicode::is_extended_pictographic(cp)
}

// The isolate-level font registry: parsed metrics keyed by an integer handle, deduped by source. A
// font's metrics don't depend on the realm, so this is thread-local, not per-realm (like the compiled
// selectors in selector.rs).
thread_local! {
    static FONTS: RefCell<Vec<Option<FontMetrics>>> = const { RefCell::new(Vec::new()) };
    static FONT_IDX: RefCell<HashMap<String, i32>> = RefCell::new(HashMap::new());
}

fn register(key: &str, bytes: &[u8]) -> i32 {
    if let Some(h) = FONT_IDX.with(|m| m.borrow().get(key).copied()) {
        return h;
    }
    let metrics = FontMetrics::from_bytes(bytes);
    let ok = metrics.is_some();
    let handle = FONTS.with(|f| {
        let mut v = f.borrow_mut();
        v.push(metrics);
        (v.len() - 1) as i32
    });
    let h = if ok { handle } else { -1 };
    FONT_IDX.with(|m| m.borrow_mut().insert(key.to_owned(), h));
    h
}

// Register a font from a fontconfig path (the host resolved it); reads + parses the file. `-1` when it
// can't be read/parsed. Idempotent per path (parsed once, handle reused, a `-1` cached too).
pub(crate) fn register_path(path: &str) -> i32 {
    let key = format!("p:{path}");
    if let Some(h) = FONT_IDX.with(|m| m.borrow().get(&key).copied()) {
        return h;
    }
    let h = match std::fs::read(path) {
        Ok(bytes) => {
            let metrics = FontMetrics::from_bytes(&bytes);
            let ok = metrics.is_some();
            let handle = FONTS.with(|f| {
                let mut v = f.borrow_mut();
                v.push(metrics);
                (v.len() - 1) as i32
            });
            if ok { handle } else { -1 }
        }
        Err(_) => -1,
    };
    FONT_IDX.with(|m| m.borrow_mut().insert(key, h));
    h
}

// The face `handle` under an `@font-face` `size-adjust` of `scale`: every advance its table gives scaled, as the JS
// model's `applyFaceMetrics` reshapes the table (a full-em wide character is no advance of the table's, and stays one em
// there too). Its own handle, shared per (face, scale); the face's handle where the scale is 1, and -1 for a face that
// is not registered.
pub(crate) fn register_scaled(handle: i32, scale: f64) -> i32 {
    if scale == 1.0 || handle < 0 {
        return handle;
    }
    let key = format!("s:{handle}:{:016x}", scale.to_bits());
    if let Some(h) = FONT_IDX.with(|m| m.borrow().get(&key).copied()) {
        return h;
    }
    let scaled = FONTS.with(|f| {
        f.borrow().get(handle as usize).and_then(Option::as_ref).map(|fm| FontMetrics {
            ascii: fm.ascii.map(|a| a.map(|a| a * scale)),
            avg: fm.avg * scale,
            split: None,
        })
    });
    let h = match scaled {
        Some(metrics) => FONTS.with(|f| {
            let mut v = f.borrow_mut();
            v.push(Some(metrics));
            (v.len() - 1) as i32
        }),
        None => -1,
    };
    FONT_IDX.with(|m| m.borrow_mut().insert(key, h));
    h
}

// A family stack whose `@font-face`s restrict their `unicode-range`s (layout.js `faceStackFor`): the face `primary`'s
// own metrics — what a character no member covers is measured by, and what a `ch` is — and `members`, in pick order.
// Its own handle, shared per (primary, members); -1 for an unregistered primary.
pub(crate) fn register_stack(primary: i32, members: Vec<StackMember>) -> i32 {
    if primary < 0 {
        return -1;
    }
    let key = format!("t:{primary}:{members:?}");
    if let Some(h) = FONT_IDX.with(|m| m.borrow().get(&key).copied()) {
        return h;
    }
    let stacked = FONTS.with(|f| {
        f.borrow().get(primary as usize).and_then(Option::as_ref).map(|fm| FontMetrics { ascii: fm.ascii, avg: fm.avg, split: Some(members.clone()) })
    });
    let h = match stacked {
        Some(metrics) => FONTS.with(|f| {
            let mut v = f.borrow_mut();
            v.push(Some(metrics));
            (v.len() - 1) as i32
        }),
        None => -1,
    };
    FONT_IDX.with(|m| m.borrow_mut().insert(key, h));
    h
}

// Register from in-memory SFNT bytes (a web / buffer face the host fetched + decoded), keyed by a
// content hash so identical bytes share one entry.
pub(crate) fn register_bytes(bytes: &[u8]) -> i32 {
    let key = format!("b:{:016x}:{}", fnv1a(bytes), bytes.len());
    register(&key, bytes)
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

// Run `f` with the FontMetrics for `handle`, or None when the handle is out of range / unusable. The
// entry point native layout uses to measure runs in-process.
pub(crate) fn with_font<R>(handle: i32, f: impl FnOnce(&FontMetrics) -> R) -> Option<R> {
    if handle < 0 {
        return None;
    }
    FONTS.with(|fonts| {
        let v = fonts.borrow();
        let fm = v.get(handle as usize)?.as_ref()?;
        Some(f(fm))
    })
}
