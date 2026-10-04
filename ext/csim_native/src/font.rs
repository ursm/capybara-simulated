// Native text metrics via fontations (skrifa / read-fonts) — the pure-Rust font stack Chrome and Servo
// use. A font file is parsed ONCE into a small advance table (printable-ASCII em-fractions + their
// mean, exactly the shape the host's `font_advance_table` builds, so run widths match bit-for-bit), and
// inline layout (mod layout) measures a run's width IN-PROCESS — no per-run V8 crossing (the granularity
// that made a per-call __dom.measureRun op a wash; see perf_dead_ends).
//
// `measure_run` is the ONE measure of a run: the ASCII table, NBSP-as-space, the CJK/fullwidth full-em fallback, the
// zero-width classes, ZWJ joining, astral full-em, and letter/word spacing — what the walk sizes a control's label by,
// the lines break by, and the painter places a character at a time by (`pen_steps`). Every character is decidable,
// the combining marks (`\p{M}`) through `unicode.rs`. Line HEIGHT is not computed here: the walk takes it from the
// style engine and the face's vertical metrics (`walk::Face`).

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
    // covers a character measures it, and one none covers is this face's own (`member_for`). None for a single face.
    split: Option<Vec<StackMember>>,
    // The `size-adjust` its advances are scaled by (`register_scaled`), which a painter draws its glyphs at too — 1 for
    // a face as its file has it.
    scale: f64,
    // Its ascent, descent and line gap in ems (`hhea`'s, or OS/2's typographic ones where it asks for those) — None where
    // it has no positive ascent — and its x-height (OS/2's
    // `sxHeight`, 0 where the table is older than version 2): what a line and an `ex` are laid out by. Scaled with the
    // advances.
    vertical: Option<VerticalMetrics>,
    x_height: f64,
    // Whether it maps any ASCII letter: a face with none (a colour emoji font maps the digits, `#` and `*` for its
    // keycaps, and no letter) sets no text, which falls back to the next family.
    letters: bool,
    // The file it was read from, which a canvas's text is shaped and drawn from (text.rs).
    path: std::sync::Arc<str>,
}

// One face of a `unicode-range` split: its registered handle, the ranges it covers (None: every code point), and its
// vertical metrics in ems — None where its table carries none.
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
pub(crate) fn code_points(text: &[u16]) -> impl Iterator<Item = u32> + '_ {
    char::decode_utf16(text.iter().copied()).map(|r| r.map_or_else(|e| e.unpaired_surrogate() as u32, |c| c as u32))
}

impl FontMetrics {
    // The advance of its `0`, in ems — what a `ch` is — else its mean advance, as a run's measure falls back (`unit_of`).
    pub(crate) fn zero_advance(&self) -> f64 {
        self.ascii[b'0' as usize].filter(|&a| a > 0.0).unwrap_or(self.avg)
    }
    // The face of a split that a character takes — the first member covering it — or None, where it takes this face's
    // own (no split, or no member covers it).
    fn member_for(&self, cp: u32) -> Option<&StackMember> {
        self.split.as_ref()?.iter().find(|m| m.covers(cp))
    }
    // The registered face a character takes in a split — its covering member's handle — or None for this face's own.
    pub(crate) fn member_handle(&self, cp: u32) -> Option<i32> {
        self.member_for(cp).map(|m| m.handle)
    }
    // Whether this face splits a run's characters across faces (`registerFontStack`).
    pub(crate) fn is_split(&self) -> bool {
        self.split.is_some()
    }
    // Whether the characters of `text` actually select more than one face of the split — a piece the painter then
    // draws a character at a time, each in its own face; one that keeps to one face is drawn whole, kerned as it is.
    pub(crate) fn splits(&self, text: &[u16]) -> bool {
        let mut faces = code_points(text).map(|cp| self.member_handle(cp));
        faces.next().is_some_and(|first| faces.any(|f| f != first))
    }
    // The line box a run of `text` needs in a split face, as the ascent and descent around its baseline: the deepest of
    // each among the faces its characters select, every one laid out as a face of its own would be — its box centred in
    // `fixed_lh` (a `line-height` that is not `normal`), else in its own box and line gap. A
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
    // Build from font file bytes (SFNT: TTF/OTF; a WOFF / WOFF2 one is unwrapped first, `sfnt`). None when the file can't
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
        use skrifa::raw::TableProvider;
        // (…its OS/2 typographic metrics where it asks for them — fsSelection's USE_TYPO_METRICS, bit 7 — as Skia reads
        // a face for Chrome; else its hhea)
        let typo = font.os2().ok().filter(|os2| os2.fs_selection().bits() & 0x80 != 0).map(|os2| (os2.s_typo_ascender(), os2.s_typo_descender(), os2.s_typo_line_gap()));
        let lines = typo.or_else(|| font.hhea().ok().map(|h| (h.ascender().to_i16(), h.descender().to_i16(), h.line_gap().to_i16())));
        let vertical = lines.and_then(|(asc, desc, gap)| {
            (asc > 0).then(|| VerticalMetrics { asc: f64::from(asc) / upem, desc: -f64::from(desc) / upem, gap: f64::from(gap) / upem })
        });
        let x_height = font.os2().ok().filter(|os2| os2.version() >= 2).and_then(|os2| os2.sx_height()).map_or(0.0, |x| f64::from(x) / upem);
        let letters = (b'A'..=b'Z').chain(b'a'..=b'z').any(|c| ascii[c as usize].is_some());
        Some(FontMetrics { ascii, avg: total / count as f64, split: None, scale: 1.0, vertical, x_height, letters, path: "".into() })
    }

    // The metrics a face's lines, its spaces and an `ex` of it are laid out by, per em: its vertical metrics — an
    // `@font-face`'s `ascent-override` / `descent-override` / `line-gap-override` (`overrides`, of the unadjusted face)
    // in its file's place, scaled by its `size-adjust` as the file's are — the advance of a space (its mean where it has
    // none) and its x-height. None where it sets no text (`letters`) or has no ascent and descent to lay a line by.
    pub(crate) fn face(&self, [asc, desc, gap]: [Option<f64>; 3]) -> Option<(VerticalMetrics, f64, f64)> {
        if !self.letters {
            return None;
        }
        let file = self.vertical;
        let vertical = VerticalMetrics {
            asc: asc.map(|a| a * self.scale).or(file.map(|v| v.asc))?,
            desc: desc.map(|d| d * self.scale).or(file.map(|v| v.desc))?,
            gap: gap.map(|g| g * self.scale).or(file.map(|v| v.gap)).unwrap_or(0.0),
        };
        Some((vertical, self.ascii[b' ' as usize].unwrap_or(self.avg), self.x_height))
    }

    // Width (px) of a UTF-16 run at `size` px with letter/word spacing.
    // Every character is measurable — the TAB was the last one that was not, and it is measured here now that
    // the pen reaches it. So this never answers None itself; it stays an `Option` because its one caller
    // (`measure_at`) reaches it through `with_font`, which answers None for a font handle that is not
    // registered, and the two Nones are indistinguishable to the caller anyway.
    // Bit-parity with the JS measure it replaced was validated over ~667k calls (perf log 2026-09-09) on
    // ASCII-and-Latin input; the other classes (wide characters, combining marks, tabs) were not covered by that.
    // `from` is the pen's distance from the block's content edge and `tab_px` / `tab_min` the stop pair a TAB
    // advances to (see `Run::tab_px`); every other character ignores all three.
    pub(crate) fn measure_run(&self, text: &[u16], size: f64, ls: f64, ws: f64, from: f64, tab_px: f64, tab_min: f64) -> f64 {
        let spaced = ls != 0.0 || ws != 0.0;
        let mut units = 0.0f64;
        let mut spacing = 0.0f64;
        let mut prev: i64 = -1;
        for cp in code_points(text) {
            if cp == 0x09 {
                // A tab's advance (`tab_advance`), on the pen this measure has reached: the distance to the
                // next stop, or to the one AFTER it where that is nearer than half a space (Blink's `Font::TabWidth`
                // — `tab-size: 20px` after 19.2px of text lands at 40, after 9.6px at 20). Stops are counted
                // from the block's content edge, which `from` is measured from, and `text-indent` does not
                // move them. It joins `spacing` rather than `units` because it is already a px advance.
                // …and `tab_px` is already final: a `tab-size` that resolved to zero took the BLOCK's
                // letter-spacing as its stop spacing back in the walk (`Walk::font_info`), so nothing here asks this RUN
                // anything. Zero means there is no stop to reach and a tab advances nothing.
                spacing += tab_advance(from + units * size + spacing, tab_px, tab_min);
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

    // Each CHARACTER of `text` as a painter places it, one at a time — a run it cannot draw whole, because a spacing or a
    // justified line's share moves its glyphs apart, a tab stops one, or a split draws them in different faces: per code
    // point `[advance, step, size]`, its glyph's own advance, how far the pen moves past it — the advance and the
    // letter-spacing it takes, the word-spacing and `justify` (a justified line's share) a space takes — and the size
    // its glyph is drawn at, a split face's `size-adjust` on it. The pen `measure_run` walks, from `from` to each tab's
    // stop.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn pen_steps(&self, text: &[u16], size: f64, ls: f64, ws: f64, justify: f64, from: f64, tab_px: f64, tab_min: f64) -> Vec<f64> {
        let mut out = Vec::new();
        let mut pen = from;
        let mut prev: i64 = -1;
        for cp in code_points(text) {
            let space = cp == 0x20 || cp == 0x00A0;
            let (advance, glyph) = if cp == 0x09 {
                (tab_advance(pen, tab_px, tab_min), size)
            } else {
                match self.member_for(cp).and_then(|m| with_font(m.handle, |fm| (unit_of(cp, prev, fm), fm.scale))) {
                    Some((units, scale)) => (units * size, size * scale),
                    None => (unit_of(cp, prev, self) * size, size),
                }
            };
            let spacing = if cp != 0x09 && takes_spacing(cp, prev) { ls + if space { ws } else { 0.0 } } else { 0.0 };
            pen += advance + spacing;
            out.extend([advance, advance + spacing + if space || cp == 0x09 { justify } else { 0.0 }, glyph]);
            prev = cp as i64;
        }
        out
    }
}

// How far a tab at `pen` advances: to the next stop `tab_px` apart, or to the one AFTER it where that is nearer than
// `tab_min`; nothing where there is no stop to reach (`tab_px` 0).
fn tab_advance(pen: f64, tab_px: f64, tab_min: f64) -> f64 {
    if tab_px <= 0.0 {
        return 0.0;
    }
    let into = pen - (pen / tab_px + 1e-9).floor() * tab_px;
    let dist = tab_px - into;
    // `<` against a half-open epsilon: Blink compares in float32, so a stop exactly `tab_min` away counts as too near.
    if dist < tab_min + 1e-6 { dist + tab_px } else { dist }
}

// Is `cp` a FULL-WIDTH character — CJK / fullwidth / Hangul, full-em in every font that has them? The break units
// follow the same classifier (`break_unit_len`), the ONE definition both read. BMP only: an astral code point is
// full-em (`unit_of`) but never its own break unit.
pub(crate) fn is_wide_char(cp: u32) -> bool {
    // A gate first (`u >= 0x1100`): every ASCII character answers on one compare instead of walking seven ranges,
    // and this is asked per WORD of every line layout, not per run.
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

// Does `cp` draw with no advance of its own — a control, a soft hyphen, a joiner, a bidi control, a variation selector, a
// combining mark? Every code point is decidable: the ranges below from structure, and the rest from
// `\p{M}` (see the last arm).
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
    // …the word joiner, the invisible operators and the bidi isolates / deprecated format characters after it, the
    // Mongolian vowel separator and the Arabic letter mark: format characters Chrome draws with no advance (all
    // sixteen of U+2060..U+206F measured, and the two others).
    if (0x2060..=0x206F).contains(&cp) || cp == 0x180E || cp == 0x061C {
        return true;
    }
    if (0xFE00..=0xFE0F).contains(&cp) {
        return true;
    }
    if (0xE0100..=0xE01EF).contains(&cp) {
        return true;
    }
    // …and the one question structure cannot answer — is this a COMBINING MARK? — is answered by `\p{M}`, the
    // property parsed from V8's own tables (`unicode.rs`).
    crate::unicode::is_combining_mark(cp)
}

// One character's advance in em-fractions — none for a pictograph a ZWJ joins to the one before it
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

// Does `cp` take a letter-spacing: once per grapheme, never on a pictograph a ZWJ joins, never on a zero-width character.
fn takes_spacing(cp: u32, prev: i64) -> bool {
    !joined(cp, prev) && !zero_width(cp)
}
// Whether `cp` is drawn as one glyph with the character before it: a pictograph a ZERO WIDTH JOINER joins (GB11), and an
// emoji MODIFIER after a pictograph — `👍🏽` is one glyph and one letter-spacing (Chrome), where a modifier alone is a
// swatch of its own.
fn joined(cp: u32, prev: i64) -> bool {
    let pict = crate::unicode::is_extended_pictographic;
    (prev == 0x200D && pict(cp)) || ((0x1F3FB..=0x1F3FF).contains(&cp) && prev >= 0 && pict(prev as u32))
}

// The isolate-level font registry: parsed metrics keyed by an integer handle, deduped by source. A
// font's metrics don't depend on the realm, so this is thread-local, not per-realm (like the compiled
// selectors in selector.rs).
thread_local! {
    static FONTS: RefCell<Vec<Option<FontMetrics>>> = const { RefCell::new(Vec::new()) };
    static FONT_IDX: RefCell<HashMap<String, i32>> = RefCell::new(HashMap::new());
}

// The SFNT a font file holds: a WOFF 1.0 container's tables inflated, a WOFF 2.0 one's Brotli stream decompressed
// and its transformed glyf / loca (and hmtx) rebuilt, anything else as it is. None for a container that does not
// decode, which a face then treats as no font at all.
pub(crate) fn sfnt(bytes: &[u8]) -> Option<std::borrow::Cow<'_, [u8]>> {
    let unwrapped = match bytes.get(..4) {
        Some(b"wOFF") => wuff::decompress_woff1(bytes),
        Some(b"wOF2") => wuff::decompress_woff2(bytes),
        _ => return Some(bytes.into()),
    };
    unwrapped.ok().map(Into::into)
}
// Capybara::Simulated::Native.font_sfnt(bytes) -> the SFNT `bytes` holds (`sfnt`), or nil.
pub(crate) fn sfnt_for_ruby(ruby: &magnus::Ruby, bytes: magnus::RString) -> Option<magnus::RString> {
    // SAFETY: the bytes are copied out before the GVL is released, and nothing else reads the string meanwhile.
    let bytes = unsafe { bytes.as_slice() }.to_vec();
    let out = crate::image_decode::without_gvl(|| std::panic::catch_unwind(|| sfnt(&bytes).map(|s| s.into_owned())).ok().flatten());
    out.map(|s| ruby.str_from_slice(&s))
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
            let metrics = FontMetrics::from_bytes(&bytes).map(|fm| FontMetrics { path: path.into(), ..fm });
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

// The face `handle` under an `@font-face` `size-adjust` of `scale`: every advance its table gives scaled, as
// font-metrics.js `applyFaceMetrics` reshapes the table (a full-em wide character is no advance of the table's, and
// stays one em there too). Its own handle, shared per (face, scale); the face's handle where the scale is 1, and -1 for
// a face that is not registered.
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
            scale: fm.scale * scale,
            vertical: fm.vertical.map(|v| VerticalMetrics { asc: v.asc * scale, desc: v.desc * scale, gap: v.gap * scale }),
            x_height: fm.x_height * scale,
            letters: fm.letters,
            path: fm.path.clone(),
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

// A family stack whose `@font-face`s restrict their `unicode-range`s (font-metrics.js `faceStackFor`): the face
// `primary`'s own metrics — what a character no member covers is measured by, and what a `ch` is — and `members`, in
// pick order.
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
        f.borrow().get(primary as usize).and_then(Option::as_ref).map(|fm| FontMetrics {
            ascii: fm.ascii,
            avg: fm.avg,
            split: Some(members.clone()),
            scale: fm.scale,
            vertical: fm.vertical,
            x_height: fm.x_height,
            letters: fm.letters,
            path: fm.path.clone(),
        })
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

impl FontMetrics {
    // The file it was read from, the `size-adjust` it is drawn at, and its vertical metrics in ems.
    pub(crate) fn source(&self) -> (std::sync::Arc<str>, f64, Option<VerticalMetrics>) {
        (self.path.clone(), self.scale, self.vertical)
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_a_woff2_with_its_outlines() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec");
        let woff2 = std::fs::read(dir.join("fixtures/fonts/Ahem.woff2")).unwrap();
        let ttf = std::fs::read(dir.join("wpt/fonts/Ahem.ttf")).unwrap();
        let out = sfnt(&woff2).expect("a decoded WOFF2");
        let (font, original) = (FontRef::new(&out).unwrap(), FontRef::new(&ttf).unwrap());
        let gid = font.charmap().map('X').unwrap();
        assert_eq!(gid, original.charmap().map('X').unwrap());
        // (…the transformed glyf / loca rebuilt: the glyph has its outline, not just its advance)
        assert!(font.outline_glyphs().get(gid).is_some_and(|g| g.draw(Size::new(10.0), &mut skrifa::outline::pen::NullPen).is_ok()));
        assert_eq!(sfnt(&ttf).as_deref(), Some(&ttf[..]));
        assert!(sfnt(b"wOF2 broken").is_none());
    }
}
