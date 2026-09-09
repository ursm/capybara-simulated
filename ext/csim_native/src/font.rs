// Native text metrics via fontations (skrifa / read-fonts) — the pure-Rust font stack Chrome and Servo
// use. A font file is parsed ONCE into a small advance table (printable-ASCII em-fractions + their
// mean, exactly the shape the host's `font_advance_table` builds, so run widths match bit-for-bit), and
// native inline layout (mod layout, stage L2) measures a run's width IN-PROCESS — no per-run V8
// crossing (the granularity that made a per-call __dom.measureRun op a wash; see perf_dead_ends).
//
// PARITY is the contract: `measure_run` reproduces layout.js `measureRun`/`unitOf` exactly, in f64 (JS
// Numbers are f64) — the ASCII table, NBSP-as-space, the CJK/fullwidth full-em fallback, the zero-width
// classes, ZWJ joining, astral full-em, and letter/word spacing. It returns None for a run holding a TAB
// or a code point at/above U+0300 that would need the `\p{M}` combining-mark test (a Unicode table); the
// caller (native line breaking) declines such a block to JS. Line HEIGHT is not computed here — JS pushes
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
}

impl FontMetrics {
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
        Some(FontMetrics { ascii, avg: total / count as f64 })
    }

    // Width (px) of a UTF-16 run at `size` px with letter/word spacing, exactly as layout.js measureRun
    // does for the common path. None when the run holds a TAB or a combining mark (≥ U+0300) — the caller
    // declines the block to JS. Validated bit-parity vs JS measureRun over ~667k calls (perf log 2026-09-09).
    pub(crate) fn measure_run(&self, text: &[u16], size: f64, ls: f64, ws: f64) -> Option<f64> {
        let spaced = ls != 0.0 || ws != 0.0;
        let mut units = 0.0f64;
        let mut spacing = 0.0f64;
        let mut prev: i64 = -1;
        let mut i = 0usize;
        while i < text.len() {
            let u = text[i];
            let cp: u32 = if (0xD800..=0xDBFF).contains(&u) && i + 1 < text.len() && (0xDC00..=0xDFFF).contains(&text[i + 1]) {
                let hi = (u as u32) - 0xD800;
                let lo = (text[i + 1] as u32) - 0xDC00;
                i += 1;
                0x10000 + (hi << 10) + lo
            } else {
                u as u32
            };
            if cp == 0x09 {
                return None; // a tab needs the block's tab stop — defer to JS
            }
            units += unit_of(cp, prev, self)?;
            if spaced && takes_spacing(cp, prev)? {
                spacing += ls + if cp == 0x20 || cp == 0x00A0 { ws } else { 0.0 };
            }
            prev = cp as i64;
            i += 1;
        }
        Some(units * size + spacing)
    }
}

// layout.js isWideChar: CJK / fullwidth / Hangul are full-em in every font that has them.
fn is_wide_char(cp: u32) -> bool {
    (0x1100..=0x115F).contains(&cp)
        || (0x2E80..=0xA4CF).contains(&cp)
        || (0xAC00..=0xD7A3).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
        || (0xFE30..=0xFE6F).contains(&cp)
        || (0xFF00..=0xFF60).contains(&cp)
        || (0xFFE0..=0xFFE6).contains(&cp)
}

// layout.js zeroWidth: Some(true/false) for the ranges decidable without a Unicode table; None for a
// code point that would reach the `\p{M}` combining-mark test — the caller falls back to JS then.
fn zero_width(cp: u32) -> Option<bool> {
    if cp < 0x20 {
        return Some(true);
    }
    if cp < 0x7F {
        return Some(false);
    }
    if cp <= 0x9F {
        return Some(true);
    }
    if cp < 0x300 {
        return Some(cp == 0xAD);
    }
    if cp == 0xFEFF || cp == 0xFFFC || cp == 0x200E || cp == 0x200F {
        return Some(true);
    }
    if (0x200B..=0x200D).contains(&cp) {
        return Some(true);
    }
    if (0x202A..=0x202E).contains(&cp) {
        return Some(true);
    }
    if (0xFE00..=0xFE0F).contains(&cp) {
        return Some(true);
    }
    if (0xE0100..=0xE01EF).contains(&cp) {
        return Some(true);
    }
    None
}

// layout.js unitOf: one character's advance in em-fractions. None when zero_width is undecidable.
fn unit_of(cp: u32, prev: i64, fm: &FontMetrics) -> Option<f64> {
    if prev == 0x200D {
        return Some(0.0);
    }
    match zero_width(cp) {
        Some(true) => return Some(0.0),
        Some(false) => {}
        None => return None,
    }
    if cp <= 0xFFFF {
        if (0x20..0x7F).contains(&cp) {
            if let Some(a) = fm.ascii[cp as usize] {
                return Some(a);
            }
        }
        if cp == 0x00A0 {
            return Some(fm.ascii[0x20].unwrap_or(fm.avg));
        }
        return Some(if is_wide_char(cp) { 1.0 } else { fm.avg });
    }
    Some(1.0)
}

// layout.js takesSpacing: once per grapheme, never after a ZWJ, never on a zero-width character.
fn takes_spacing(cp: u32, prev: i64) -> Option<bool> {
    if prev == 0x200D {
        return Some(false);
    }
    Some(!zero_width(cp)?)
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
