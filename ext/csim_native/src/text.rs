// A canvas's text (HTML §4.12.5.1.4, "text preparation algorithm", and measureText's TextMetrics): a line shaped as
// HarfBuzz shapes it (harfrust) in the face its family resolved to — the very file the layout measures with — kerned
// unless `fontKerning` says none, a character the face does not map set in the face fontconfig finds for it; its
// glyphs' outlines (skrifa) filled into a coverage mask cropped to their ink; and the metrics measureText reports, as
// Chrome reports them (measured): the advance as shaped, the ink box's left / ascent / descent in whole pixels and its
// right as it lies, the face's ascent and descent (its `hhea`, as the layout's line boxes take them) rounded, the
// baselines from its `BASE` table where it has one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use harfrust::{Direction, Feature, ShapeOptions, ShaperData, Tag, UnicodeBuffer};
use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::{FontRef, MetadataProvider};

use crate::canvas_path::Ring;

// A face's file, read once per process: what a canvas's text is shaped and drawn from.
fn file(path: &str) -> Option<Arc<[u8]>> {
    static FILES: OnceLock<Mutex<HashMap<String, Option<Arc<[u8]>>>>> = OnceLock::new();
    let mut files = FILES.get_or_init(Default::default).lock().ok()?;
    files.entry(path.to_owned()).or_insert_with(|| std::fs::read(path).ok().map(Arc::from)).clone()
}

// A run of the line in one face at one size: its text, the face's file, and its size as a multiple of the font's (its
// face's `size-adjust`, and a synthesized small capital's 0.7).
struct Run {
    text: String,
    data: Arc<[u8]>,
    size: f64,
}

// Chrome's synthesized small capitals: a lowercase letter set as its capital at this fraction of the font size, where
// the face has no `smcp` of its own.
const SMALL_CAPS_SIZE: f64 = 0.7;

// The line's own face: the one `handle` (font.rs) names, or — where its `@font-face`s split by `unicode-range` — the
// member a character's code point picks; its file and its `size-adjust`.
fn face_of_handle(handle: i32, c: char) -> Option<(Arc<[u8]>, f64)> {
    let handle = crate::font::with_font(handle, |fm| fm.member_handle(u32::from(c)))?.unwrap_or(handle);
    let (path, scale, _) = crate::font::with_font(handle, |fm| fm.source())?;
    Some((file(&path)?, scale))
}

// The line split into runs by the face each character is set in: the line's own (`face_of_handle`), else — for a
// character it does not map — fontconfig's face for that character (the first face that has it, as pango asks
// fontconfig), else the line's own still (its `.notdef`). With `small_caps` and a face without `smcp`, a lowercase
// letter becomes its capital, at `SMALL_CAPS_SIZE`.
fn runs(text: &str, handle: i32, small_caps: bool) -> Vec<Run> {
    let maps = |data: &[u8], c: char| FontRef::new(data).ok().is_some_and(|f| f.charmap().map(c).is_some());
    let mut fallbacks: HashMap<String, Option<Arc<[u8]>>> = HashMap::new();
    let mut out: Vec<Run> = Vec::new();
    let mut chars = text.chars().peekable();
    let mut face_for = |pattern: String, c: char| -> Option<Arc<[u8]>> {
        let path = crate::fontconfig::font_match(&pattern)?.0;
        fallbacks.entry(path.clone()).or_insert_with(|| file(&path)).clone().filter(|d| maps(d, c))
    };
    while let Some(c) = chars.next() {
        let Some((own, scale)) = face_of_handle(handle, c) else { continue };
        let lower = small_caps && c.is_lowercase() && c.to_uppercase().next() != Some(c) && !has_feature(&own, b"smcp");
        // (…a variation selector after a character asks for its emoji presentation — VS16, the colour emoji face — or
        // its text one, VS15, as Chrome picks the face by it; the selector itself goes with the character)
        let next = chars.peek().copied();
        let presentation = match next {
            Some('\u{FE0F}') => "emoji:color=true",
            Some('\u{FE0E}') => ":color=false",
            _ => "",
        };
        // (…the line's own face where it maps the character — its variation sequences picking the presentation, as the
        // shaper reads them — else whichever face has it: a colour emoji one for VS16, one that is not for VS15)
        let (data, scale) = if maps(&own, c) || c.is_whitespace() || c.is_control() || ignorable(c) {
            (own, scale)
        } else {
            face_for(format!("{presentation}:charset={:x}", u32::from(c)), c).map_or((own, scale), |d| (d, 1.0))
        };
        let size = scale * if lower { SMALL_CAPS_SIZE } else { 1.0 };
        let mut set: String = if lower { c.to_uppercase().collect() } else { c.to_string() };
        if let Some(vs @ ('\u{FE0E}' | '\u{FE0F}')) = next {
            set.push(vs);
            chars.next();
        }
        match out.last_mut() {
            Some(run) if Arc::ptr_eq(&run.data, &data) && run.size == size => run.text.push_str(&set),
            _ => out.push(Run { text: set, data, size }),
        }
    }
    out
}
// A Default_Ignorable_Code_Point the line keeps in its own face, for the shaper to hide (zero-width spaces and joiners,
// the bidi marks and embeddings, word joiners and invisible operators, variation selectors, the BOM, tags).
fn ignorable(c: char) -> bool {
    matches!(u32::from(c), 0xAD | 0x34F | 0x61C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFF8 | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0000..=0xE0FFF)
}
// Whether a face's GSUB has the feature `tag` (a feature record of any script).
fn has_feature(data: &[u8], tag: &[u8; 4]) -> bool {
    use skrifa::raw::TableProvider;
    let Ok(font) = FontRef::new(data) else { return false };
    font.gsub().ok().and_then(|g| g.feature_list().ok()).is_some_and(|list| list.feature_records().iter().any(|r| r.feature_tag() == skrifa::raw::types::Tag::new(tag)))
}

// A glyph placed on the line: its face, its id, and where its origin lies (px, the pen's x and the baseline's y-up
// offset), at the scale its face's units are drawn at.
struct Placed {
    data: Arc<[u8]>,
    glyph: u32,
    x: f64,
    y: f64,
    scale: f64,
}

// The line shaped: its glyphs placed, and its advance (px). `size` is the font size in px, before a face's
// `size-adjust`; `small_caps` turns the face's `smcp` on, or synthesizes it (`runs`). Its characters are put in visual order by the Unicode bidirectional
// algorithm (UAX #9) on the base direction `rtl` says — the canvas's `direction` — and each level run shaped in its
// own direction, a right-to-left one's face runs laid down from its end.
fn shape(text: &str, handle: i32, size: f64, kerning: bool, small_caps: bool, rtl: bool) -> (Vec<Placed>, f64) {
    let mut features = Vec::new();
    if !kerning {
        features.push(Feature::new(Tag::new(b"kern"), 0, ..));
    }
    if small_caps {
        features.push(Feature::new(Tag::new(b"smcp"), 1, ..));
    }
    let mut placed = Vec::new();
    let mut pen = 0.0;
    let base = if rtl { unicode_bidi::Level::rtl() } else { unicode_bidi::Level::ltr() };
    let bidi = unicode_bidi::BidiInfo::new(text, Some(base));
    let mut ordered: Vec<(Run, bool)> = Vec::new();
    for para in &bidi.paragraphs {
        let (levels, visual) = bidi.visual_runs(para, para.range.clone());
        for range in visual {
            let rtl_run = levels[range.start].is_rtl();
            let mut face_runs = runs(&text[range], handle, small_caps);
            if rtl_run {
                face_runs.reverse();
            }
            ordered.extend(face_runs.into_iter().map(|run| (run, rtl_run)));
        }
    }
    for (run, rtl_run) in ordered {
        let Ok(font) = harfrust::FontRef::new(&run.data) else { continue };
        let upem = f64::from(FontRef::new(&run.data).map_or(1000, |f| f.metrics(Size::unscaled(), LocationRef::default()).units_per_em));
        let scale = size * run.size / upem;
        let data = ShaperData::new(&font);
        let shaper = data.shaper(&font).build();
        let mut buffer = UnicodeBuffer::new();
        buffer.push_str(&run.text);
        buffer.set_direction(if rtl_run { Direction::RightToLeft } else { Direction::LeftToRight });
        buffer.guess_segment_properties();
        let glyphs = shaper.shape(buffer, ShapeOptions::new().features(&features));
        for (info, pos) in glyphs.glyph_infos().iter().zip(glyphs.glyph_positions()) {
            placed.push(Placed { data: run.data.clone(), glyph: info.glyph_id, x: pen + f64::from(pos.x_offset) * scale, y: f64::from(pos.y_offset) * scale, scale });
            pen += f64::from(pos.x_advance) * scale;
        }
    }
    (placed, pen)
}

// A glyph's outline as rings in px, y down from the baseline: its curves flattened.
struct Rings {
    rings: Vec<Ring>,
    cur: Ring,
    at: (f64, f64),
    // The glyph's origin on the line, and the px per font unit.
    origin: (f64, f64),
}

impl Rings {
    fn point(&self, x: f32, y: f32) -> (f64, f64) {
        (self.origin.0 + f64::from(x), self.origin.1 - f64::from(y))
    }
    fn push(&mut self, p: (f64, f64)) {
        self.cur.push(p);
        self.at = p;
    }
    // A curve through `ctrl` to `to`, as enough straight pieces that none strays a tenth of a pixel.
    fn curve(&mut self, ctrl: &[(f64, f64)], to: (f64, f64)) {
        let from = self.at;
        let len: f64 = std::iter::once(from).chain(ctrl.iter().copied()).zip(ctrl.iter().copied().chain([to])).map(|(a, b)| (b.0 - a.0).hypot(b.1 - a.1)).sum();
        let n = (len / 2.0).sqrt().ceil().clamp(1.0, 64.0) as usize;
        for i in 1..=n {
            let t = i as f64 / n as f64;
            let u = 1.0 - t;
            let p = match ctrl {
                [c] => (u * u * from.0 + 2.0 * u * t * c.0 + t * t * to.0, u * u * from.1 + 2.0 * u * t * c.1 + t * t * to.1),
                [c1, c2] => (
                    u * u * u * from.0 + 3.0 * u * u * t * c1.0 + 3.0 * u * t * t * c2.0 + t * t * t * to.0,
                    u * u * u * from.1 + 3.0 * u * u * t * c1.1 + 3.0 * u * t * t * c2.1 + t * t * t * to.1,
                ),
                _ => to,
            };
            self.push(p);
        }
    }
}

impl OutlinePen for Rings {
    fn move_to(&mut self, x: f32, y: f32) {
        self.close();
        let p = self.point(x, y);
        self.push(p);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let p = self.point(x, y);
        self.push(p);
    }
    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        let (c, to) = (self.point(cx0, cy0), self.point(x, y));
        self.curve(&[c], to);
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        let (c1, c2, to) = (self.point(cx0, cy0), self.point(cx1, cy1), self.point(x, y));
        self.curve(&[c1, c2], to);
    }
    fn close(&mut self) {
        if self.cur.len() > 2 {
            self.rings.push(std::mem::take(&mut self.cur));
        } else {
            self.cur.clear();
        }
    }
}

// A glyph a face has as a bitmap and no outline (a CBDT colour emoji): its box in px (left, top from the baseline,
// width, height) and the image's alpha, which covers as an outline's area does — its colours are not drawn (the line
// is one coverage mask, filled with the fill style).
struct Sprite {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    image: image::GrayImage,
}

// The glyph `g`'s bitmap at its size, as a sprite — None where its face has none for it.
fn sprite(font: &FontRef, g: &Placed, upem: f64) -> Option<Sprite> {
    let strikes = skrifa::bitmap::BitmapStrikes::new(font);
    let glyph = strikes.glyph_for_size(Size::new((g.scale * upem) as f32), skrifa::GlyphId::new(g.glyph))?;
    let skrifa::bitmap::BitmapData::Png(png) = glyph.data else { return None };
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?.to_rgba8();
    let alpha = image::GrayImage::from_fn(image.width(), image.height(), |x, y| image::Luma([image.get_pixel(x, y)[3]]));
    let k = g.scale * upem / f64::from(glyph.ppem_y);
    let (w, h) = (f64::from(image.width()) * k, f64::from(image.height()) * k);
    let top = match glyph.placement_origin {
        skrifa::bitmap::Origin::TopLeft => -f64::from(glyph.inner_bearing_y) * k,
        skrifa::bitmap::Origin::BottomLeft => -f64::from(glyph.inner_bearing_y) * k - h,
    };
    Some(Sprite { left: g.x + f64::from(glyph.inner_bearing_x) * k, top: top - g.y, width: w, height: h, image: alpha })
}

// The line's glyph outlines, as rings in px (y down from the baseline, x from the pen's start), its bitmap glyphs, and
// its ink box's left and right edges: each glyph's own rounded out to whole pixels from its origin, as Skia bounds a
// glyph (Chrome's actualBoundingBoxLeft / Right, measured) — None for a line with no ink.
fn outlines(placed: &[Placed]) -> (Vec<Ring>, Vec<Sprite>, Option<(f64, f64)>) {
    let mut pen = Rings { rings: Vec::new(), cur: Vec::new(), at: (0.0, 0.0), origin: (0.0, 0.0) };
    let mut sprites = Vec::new();
    let mut edges: Option<(f64, f64)> = None;
    let mut widen = |edges: &mut Option<(f64, f64)>, l: f64, r: f64| *edges = Some(edges.map_or((l, r), |(el, er)| (el.min(l), er.max(r))));
    for g in placed {
        let Ok(font) = FontRef::new(&g.data) else { continue };
        let upem = f64::from(font.metrics(Size::unscaled(), LocationRef::default()).units_per_em);
        let Some(outline) = font.outline_glyphs().get(skrifa::GlyphId::new(g.glyph)) else {
            if let Some(s) = sprite(&font, g, upem) {
                widen(&mut edges, g.x + (s.left - g.x).floor(), g.x + (s.left + s.width - g.x).ceil());
                sprites.push(s);
            }
            continue;
        };
        pen.origin = (g.x, -g.y);
        let first = pen.rings.len();
        let settings = DrawSettings::unhinted(Size::new((g.scale * upem) as f32), LocationRef::default());
        if outline.draw(settings, &mut pen).is_ok() {
            pen.close();
        }
        let xs = pen.rings[first..].iter().flatten().map(|p| p.0 - g.x);
        let (l, r) = xs.fold((f64::INFINITY, f64::NEG_INFINITY), |(l, r), x| (l.min(x), r.max(x)));
        if l.is_finite() {
            widen(&mut edges, g.x + l.floor(), g.x + r.ceil());
        }
    }
    (pen.rings, sprites, edges)
}

// What measureText and fillText are told of a line.
pub(crate) struct Line {
    pub(crate) advance: f64,
    // The ink box: left (px from the pen's start), right, ascent and descent (px above / below the baseline).
    pub(crate) ink: [f64; 4],
    // The face's ascent and descent, px; and the em square's, split at the baseline as its typographic ascender and
    // descender split them (OS/2, else hhea).
    pub(crate) ascent: f64,
    pub(crate) descent: f64,
    pub(crate) em: (f64, f64),
    // The `BASE` table's hanging and ideographic baselines, px above the alphabetic one — None without one.
    pub(crate) baselines: Option<(f64, f64)>,
    // The coverage mask of the ink, cropped to whole pixels around it: its left and top (px from the pen's start, the
    // baseline), its size, and its bytes — none where it was only measured, or has no ink.
    pub(crate) mask: Option<(i64, i64, usize, usize, Vec<u8>)>,
}

// `text` in the face `handle` (font.rs) at `size` px: shaped, measured, and — unless `measure_only` — drawn.
pub(crate) fn line(text: &str, handle: i32, size: f64, kerning: bool, small_caps: bool, rtl: bool, measure_only: bool) -> Option<Line> {
    // (…a NUL takes up no space, as Chrome sets it)
    let text = text.replace('\0', "");
    let (path, face_scale, vertical) = crate::font::with_font(handle, |fm| fm.source())?;
    let primary = file(&path)?;
    let (placed, advance) = shape(&text, handle, size, kerning, small_caps, rtl);
    let (rings, sprites, edges) = outlines(&placed);
    let (mut l, mut t, mut r, mut b) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let corners = sprites.iter().flat_map(|s| [(s.left, s.top), (s.left + s.width, s.top + s.height)]);
    for (x, y) in rings.iter().flatten().copied().chain(corners) {
        (l, t, r, b) = (l.min(x), t.min(y), r.max(x), b.max(y));
    }
    let inked = l.is_finite();
    // (…its ascent and descent to the nearest pixel: Chrome's come off hinted outlines, which these are not)
    let ink = edges.map_or([0.0; 4], |(el, er)| [el, er, (-t).round(), b.round()]);
    // (…the face's vertical metrics carry its `size-adjust` already; its em square and baselines are at the size it
    // draws at)
    let (asc, desc) = vertical.map_or((0.8 * face_scale, 0.2 * face_scale), |v| (v.asc, v.desc));
    let face_size = size * face_scale;
    let mask = (inked && !measure_only).then(|| {
        let (x0, y0) = (l.floor() as i64, t.floor() as i64);
        let (w, h) = ((r.ceil() as i64 - x0).max(1) as usize, (b.ceil() as i64 - y0).max(1) as usize);
        let mut bytes = vec![0u8; w * h];
        let shift = (-(x0 as f64), -(y0 as f64));
        let _ = crate::canvas::cover_rings(&rings, false, w, h, shift, &mut |x, y, c| bytes[y * w + x] = (c * 255.0).round() as u8);
        // (…a bitmap glyph's alpha, sampled at each pixel's centre, where it covers more)
        for s in &sprites {
            let (iw, ih) = (s.image.width(), s.image.height());
            for (py, row) in bytes.chunks_exact_mut(w).enumerate() {
                let v = (y0 as f64 + py as f64 + 0.5 - s.top) / s.height;
                if !(0.0..1.0).contains(&v) {
                    continue;
                }
                for (px, cell) in row.iter_mut().enumerate() {
                    let u = (x0 as f64 + px as f64 + 0.5 - s.left) / s.width;
                    if (0.0..1.0).contains(&u) {
                        let a = s.image.get_pixel((u * f64::from(iw)) as u32, (v * f64::from(ih)) as u32)[0];
                        *cell = (*cell).max(a);
                    }
                }
            }
        }
        (x0, y0, w, h, bytes)
    });
    let em = em_split(&primary).map_or((face_size, 0.0), |r| ((face_size * r).round(), (face_size * (1.0 - r)).round()));
    // (…`+ 0.0`: a descent that rounds to zero is 0, not -0)
    Some(Line { advance, ink, ascent: (asc * size).round() + 0.0, descent: (desc * size).round() + 0.0, em, baselines: base_baselines(&primary, face_size), mask })
}
// The fraction of the em square above the baseline: the face's typographic ascender over its ascender and descender
// (OS/2, else hhea) — None where they span nothing.
fn em_split(data: &[u8]) -> Option<f64> {
    use skrifa::raw::TableProvider;
    let font = FontRef::new(data).ok()?;
    let (asc, desc) = match font.os2() {
        Ok(os2) => (f64::from(os2.s_typo_ascender()), f64::from(os2.s_typo_descender())),
        Err(_) => font.hhea().ok().map(|h| (f64::from(h.ascender().to_i16()), f64::from(h.descender().to_i16())))?,
    };
    (asc - desc > 0.0).then(|| asc / (asc - desc))
}

// The hanging and ideographic baselines a face's `BASE` table gives (its horizontal axis, the DFLT or latn script, else
// its first), px above the alphabetic one at `size` — None where it has no table, or no coordinates.
fn base_baselines(data: &[u8], size: f64) -> Option<(f64, f64)> {
    let font = FontRef::new(data).ok()?;
    let upem = f64::from(font.metrics(Size::unscaled(), LocationRef::default()).units_per_em);
    let base = font.table_data(skrifa::raw::types::Tag::new(b"BASE"))?;
    let b = base.as_bytes();
    let u16_at = |at: usize| Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?) as usize);
    let i16_at = |at: usize| Some(i16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?));
    let horiz = match u16_at(4)? {
        0 => return None,
        o => o,
    };
    let (tags, scripts) = (horiz + u16_at(horiz)?, horiz + u16_at(horiz + 2)?);
    let (ntags, nscripts) = (u16_at(tags)?, u16_at(scripts)?);
    let tag = |i: usize| b.get(tags + 2 + i * 4..tags + 6 + i * 4);
    let record = |i: usize| Some((b.get(scripts + 2 + i * 6..scripts + 6 + i * 6)?, scripts + u16_at(scripts + 6 + i * 6)?));
    let script = (0..nscripts).filter_map(record).find(|(t, _)| *t == b"DFLT" || *t == b"latn").or_else(|| record(0))?.1;
    let values = match u16_at(script)? {
        0 => return None,
        o => script + o,
    };
    let ncoords = u16_at(values + 2)?;
    let mut coords: HashMap<&[u8], i16> = HashMap::new();
    for i in 0..ntags.min(ncoords) {
        let coord = values + u16_at(values + 4 + i * 2)?;
        if (1..=3).contains(&u16_at(coord)?) {
            coords.insert(tag(i)?, i16_at(coord + 2)?);
        }
    }
    if coords.is_empty() {
        return None;
    }
    let romn = f64::from(coords.get(&b"romn"[..]).copied().unwrap_or(0));
    let at = |t: &[u8]| (coords.get(t).map_or(romn, |&v| f64::from(v)) - romn) * size / upem;
    Some((at(b"hang"), at(b"ideo")))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "canvasText", canvas_text, context_id);
    crate::dom::register(scope, ns, "firstStrongDirection", first_strong_direction, context_id);
}

// __dom.firstStrongDirection(text) -> whether a paragraph's first strong character is right-to-left (UAX #9 P2–P3:
// true for R or AL, false for L), undefined where it has none.
fn first_strong_direction(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    match unicode_bidi::get_base_direction(text.as_str()) {
        unicode_bidi::Direction::Rtl => rv.set_bool(true),
        unicode_bidi::Direction::Ltr => rv.set_bool(false),
        unicode_bidi::Direction::Mixed => {}
    }
}

// __dom.canvasText(text, handle, size, kerning, smallCaps, rtl, measureOnly) -> the line `text` makes in the face
// `handle` at `size` px, on a right-to-left base direction where `rtl` (`line`): `{advance, inkLeft, inkRight, inkAscent, inkDescent, ascent, descent, emAscent, emDescent
// [, hangingBaseline,
// ideographicBaseline][, maskX, maskY, maskWidth, maskHeight, mask]}` — the mask's left and top px from the pen's start
// and the baseline, its bytes a Uint8Array of coverage — or null where the face is none native reads.
fn canvas_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    let handle = args.get(1).int32_value(scope).unwrap_or(-1);
    let size = args.get(2).number_value(scope).unwrap_or(10.0);
    let [kerning, small_caps, rtl, measure_only] = [3, 4, 5, 6].map(|k| args.get(k).boolean_value(scope));
    let Some(line) = std::panic::catch_unwind(|| line(&text, handle, size, kerning, small_caps, rtl, measure_only)).ok().flatten() else { return rv.set_null() };
    let obj = v8::Object::new(scope);
    let mut set = |scope: &mut v8::PinScope<'_, '_>, key: &str, value: v8::Local<'_, v8::Value>| {
        let key = v8::String::new(scope, key).expect("a short string");
        obj.set(scope, key.into(), value);
    };
    let [l, r, a, d] = line.ink;
    let mut numbers = vec![
        ("advance", line.advance),
        ("inkLeft", l),
        ("inkRight", r),
        ("inkAscent", a),
        ("inkDescent", d),
        ("ascent", line.ascent),
        ("descent", line.descent),
        ("emAscent", line.em.0),
        ("emDescent", line.em.1),
    ];
    if let Some((hang, ideo)) = line.baselines {
        numbers.extend([("hangingBaseline", hang), ("ideographicBaseline", ideo)]);
    }
    if let Some((x, y, w, h, _)) = &line.mask {
        numbers.extend([("maskX", *x as f64), ("maskY", *y as f64), ("maskWidth", *w as f64), ("maskHeight", *h as f64)]);
    }
    for (key, n) in numbers {
        let value = v8::Number::new(scope, n).into();
        set(scope, key, value);
    }
    if let Some((.., bytes)) = line.mask {
        let mask = crate::dom::u8_array(scope, bytes);
        set(scope, "mask", mask);
    }
    rv.set(obj.into());
}
