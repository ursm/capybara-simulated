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

// A face text is shaped and drawn in: its file's bytes, the index of the face in them (a collection — a `.ttc` — holds
// several), and its shaping tables, parsed once. Read once per process (`face`).
struct Face {
    data: Arc<[u8]>,
    index: u32,
    shaper: ShaperData,
}

impl Face {
    fn font(&self) -> FontRef<'_> {
        FontRef::from_index(&self.data, self.index).expect("a face `face` parsed")
    }
    fn maps(&self, c: char) -> bool {
        self.font().charmap().map(c).is_some()
    }
    fn upem(&self) -> f64 {
        f64::from(self.font().metrics(Size::unscaled(), LocationRef::default()).units_per_em)
    }
}

// The face fontconfig named (`font::face_name`), read the first time it is asked for — None where it is none skrifa
// parses.
fn face(name: &str) -> Option<Arc<Face>> {
    static FACES: OnceLock<Mutex<HashMap<String, Option<Arc<Face>>>>> = OnceLock::new();
    let mut faces = FACES.get_or_init(Default::default).lock().ok()?;
    faces
        .entry(name.to_owned())
        .or_insert_with(|| {
            let (path, index) = crate::font::face_file(name);
            let data: Arc<[u8]> = std::fs::read(path).ok()?.into();
            let shaper = ShaperData::new(&FontRef::from_index(&data, index).ok()?);
            Some(Arc::new(Face { data, index, shaper }))
        })
        .clone()
}

// The face fontconfig finds for `pattern` (a character's `:charset=`, its presentation), asked once per process: the
// faces installed do not change under a running process.
fn fallback(pattern: String) -> Option<Arc<Face>> {
    static FALLBACKS: OnceLock<Mutex<HashMap<String, Option<Arc<Face>>>>> = OnceLock::new();
    let cached = FALLBACKS.get_or_init(Default::default).lock().ok()?.get(&pattern).cloned();
    cached.unwrap_or_else(|| {
        let found = crate::fontconfig::font_match(&pattern).and_then(|(name, _)| face(&name));
        FALLBACKS.get_or_init(Default::default).lock().ok()?.insert(pattern, found.clone());
        found
    })
}

// A run of the line in one face at one size: its text, the face, and its size as a multiple of the font's (its face's
// `size-adjust`, and a synthesized small capital's 0.7).
struct Run {
    text: String,
    face: Arc<Face>,
    size: f64,
}

// Chrome's synthesized small capitals: a lowercase letter set as its capital at this fraction of the font size, where
// the face has no `smcp` of its own.
const SMALL_CAPS_SIZE: f64 = 0.7;

// The line's own face: the one `handle` (font.rs) names, or — where its `@font-face`s split by `unicode-range` — the
// member a character's code point picks; and its `size-adjust`.
fn face_of_handle(handle: i32, c: char) -> Option<(Arc<Face>, f64)> {
    let handle = crate::font::with_font(handle, |fm| fm.member_handle(u32::from(c)))?.unwrap_or(handle);
    let (name, scale, _) = crate::font::with_font(handle, |fm| fm.source())?;
    Some((face(&name)?, scale))
}

// The line split into runs by the face each character is set in: the line's own (`face_of_handle`), else — for a
// character it does not map — fontconfig's face for that character (the first face that has it, as Chrome asks
// fontconfig), else the line's own still (its `.notdef`). With `small_caps` and a face without `smcp`, a lowercase
// letter becomes its capital, at `SMALL_CAPS_SIZE`.
fn runs(text: &str, handle: i32, small_caps: bool) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    let mut chars = text.chars().peekable();
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
        let (face, scale) = if own.maps(c) || c.is_whitespace() || c.is_control() || ignorable(c) {
            (own, scale)
        } else {
            fallback(format!("{presentation}:charset={:x}", u32::from(c))).filter(|f| f.maps(c)).map_or((own, scale), |f| (f, 1.0))
        };
        let size = scale * if lower { SMALL_CAPS_SIZE } else { 1.0 };
        let mut set: String = if lower { c.to_uppercase().collect() } else { c.to_string() };
        if let Some(vs @ ('\u{FE0E}' | '\u{FE0F}')) = next {
            set.push(vs);
            chars.next();
        }
        match out.last_mut() {
            Some(run) if Arc::ptr_eq(&run.face, &face) && run.size == size => run.text.push_str(&set),
            _ => out.push(Run { text: set, face, size }),
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
fn has_feature(face: &Face, tag: &[u8; 4]) -> bool {
    use skrifa::raw::TableProvider;
    face.font().gsub().ok().and_then(|g| g.feature_list().ok()).is_some_and(|list| list.feature_records().iter().any(|r| r.feature_tag() == skrifa::raw::types::Tag::new(tag)))
}

// A glyph placed on the line: its face, its id, and where its origin lies (px, the pen's x and the baseline's y-up
// offset), at the scale its face's units are drawn at.
struct Placed {
    face: Arc<Face>,
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
        let font = run.face.font();
        let scale = size * run.size / run.face.upem();
        let shaper = run.face.shaper.shaper(&font).build();
        let mut buffer = UnicodeBuffer::new();
        buffer.push_str(&run.text);
        buffer.set_direction(if rtl_run { Direction::RightToLeft } else { Direction::LeftToRight });
        buffer.guess_segment_properties();
        let glyphs = shaper.shape(buffer, ShapeOptions::new().features(&features));
        for (info, pos) in glyphs.glyph_infos().iter().zip(glyphs.glyph_positions()) {
            placed.push(Placed { face: run.face.clone(), glyph: info.glyph_id, x: pen + f64::from(pos.x_offset) * scale, y: f64::from(pos.y_offset) * scale, scale });
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
        let (font, upem) = (g.face.font(), g.face.upem());
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
    // Where it was drawn (`Placement`), what of its ink reaches the canvas — none where nothing does.
    pub(crate) mask: Option<Mask>,
}

// A drawn line's coverage on the canvas: its left and top in device pixels, its size, and a byte of coverage a pixel —
// condensed already where `maxWidth` squeezes the line.
pub(crate) struct Mask {
    pub(crate) x: i64,
    pub(crate) y: i64,
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) bytes: Vec<u8>,
}

// Where a line is drawn (HTML §4.12.5.1.4, the text preparation algorithm's anchor point), in device pixels: its anchor
// (fillText's x, y through the CTM), the fraction of its advance `textAlign` puts left of that (0, ½ or 1), its
// `textBaseline`, the width `maxWidth` condenses it to (0: none), and the window of device pixels that can reach the
// canvas (left, top, right, bottom) — the canvas's own, and where the shadow's offset brings the rest from — which a
// shadow's blur (`shadow_blur`, its `shadowBlur`; 0 for none) widens by its reach.
pub(crate) struct Placement {
    pub(crate) anchor: (f64, f64),
    pub(crate) align: f64,
    pub(crate) baseline: Baseline,
    pub(crate) max_width: f64,
    pub(crate) window: [f64; 4],
    pub(crate) shadow_blur: f64,
}

// `textBaseline`, in the IDL enumeration's order.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Baseline {
    Top,
    Hanging,
    Middle,
    Alphabetic,
    Ideographic,
    Bottom,
}

impl Baseline {
    fn from_index(i: i32) -> Baseline {
        [Baseline::Top, Baseline::Hanging, Baseline::Middle, Baseline::Alphabetic, Baseline::Ideographic, Baseline::Bottom]
            .get(i as usize)
            .copied()
            .unwrap_or(Baseline::Alphabetic)
    }
}

// `text` in the face `handle` (font.rs) at `size` px: shaped, measured, and — where it is `place`d — drawn.
pub(crate) fn line(text: &str, handle: i32, size: f64, kerning: bool, small_caps: bool, rtl: bool, place: Option<&Placement>) -> Option<Line> {
    // (…a NUL takes up no space, as Chrome sets it)
    let text = text.replace('\0', "");
    let (name, face_scale, vertical) = crate::font::with_font(handle, |fm| fm.source())?;
    let primary = face(&name)?;
    let (placed, advance) = shape(&text, handle, size, kerning, small_caps, rtl);
    let (rings, sprites, edges) = outlines(&placed);
    let (mut l, mut t, mut r, mut b) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let corners = sprites.iter().flat_map(|s| [(s.left, s.top), (s.left + s.width, s.top + s.height)]);
    for (x, y) in rings.iter().flatten().copied().chain(corners) {
        (l, t, r, b) = (l.min(x), t.min(y), r.max(x), b.max(y));
    }
    // (…its ascent and descent to the nearest pixel: Chrome's come off hinted outlines, which these are not)
    let ink = edges.map_or([0.0; 4], |(el, er)| [el, er, (-t).round(), b.round()]);
    // (…the face's vertical metrics carry its `size-adjust` already; its em square and baselines are at the size it
    // draws at)
    let (asc, desc) = vertical.map_or((0.8 * face_scale, 0.2 * face_scale), |v| (v.asc, v.desc));
    let face_size = size * face_scale;
    let em = em_split(&primary).map_or((face_size, 0.0), |r| ((face_size * r).round(), (face_size * (1.0 - r)).round()));
    let mut line = Line {
        advance,
        ink,
        // (…`+ 0.0`: a descent that rounds to zero is 0, not -0)
        ascent: (asc * size).round() + 0.0,
        descent: (desc * size).round() + 0.0,
        em,
        baselines: base_baselines(&primary, face_size),
        mask: None,
    };
    if let Some(place) = place.filter(|_| l.is_finite()) {
        line.mask = line.draw(place, (l, t, r, b), &rings, &sprites);
    }
    Some(line)
}

impl Line {
    // The coverage of the line's ink — `rings` and `sprites`, inside `bounds` (left, top, right, bottom: px from the pen's
    // start and the baseline) — placed where `place` puts it, of which only what lies in its window is rasterized: a
    // line at 30000px, or far off the canvas, costs the pixels it shows.
    fn draw(&self, place: &Placement, bounds: (f64, f64, f64, f64), rings: &[Ring], sprites: &[Sprite]) -> Option<Mask> {
        let (l, t, r, b) = bounds;
        // (…maxWidth condenses the line horizontally, never wraps; alignment goes by its advance as condensed)
        let squeeze = if place.max_width > 0.0 && self.advance > place.max_width { place.max_width / self.advance } else { 1.0 };
        let above = match place.baseline {
            Baseline::Top => self.em.0,
            Baseline::Hanging => self.baselines.map_or(self.ascent * 0.8, |(hang, _)| hang),
            Baseline::Middle => (self.em.0 - self.em.1) / 2.0,
            Baseline::Alphabetic => 0.0,
            Baseline::Ideographic if self.baselines.is_some() => self.baselines.map_or(0.0, |(_, ideo)| ideo),
            Baseline::Ideographic | Baseline::Bottom => -self.em.1,
        };
        let origin = (place.anchor.0 - self.advance * squeeze * place.align, place.anchor.1 + above);
        // (…the ink in whole pixels, its left edge squeezed with the line, then what of it falls in the window: output
        // columns and rows, and the source columns those sample)
        let (x0, y0) = (l.floor(), t.floor());
        let (w, h) = ((r.ceil() - x0).max(1.0) as usize, (b.ceil() - y0).max(1.0) as usize);
        let out_w = if squeeze == 1.0 { w } else { ((w as f64 * squeeze).round() as usize).max(1) };
        let (ink_x, ink_y) = ((origin.0 + x0 * squeeze).round(), (origin.1 + y0).round());
        let span = |lo: f64, hi: f64, at: f64, n: usize| ((lo.floor() - at).clamp(0.0, n as f64) as usize, (hi.ceil() - at).clamp(0.0, n as f64) as usize);
        let [wl, wt, wr, wb] = place.window;
        let reach = crate::canvas::blur_reach(crate::canvas::blur_radius(place.shadow_blur), (wr - wl).max(0.0) as usize, (wb - wt).max(0.0) as usize) as f64;
        let [wl, wt, wr, wb] = [wl - reach, wt - reach, wr + reach, wb + reach];
        let ((j0, j1), (i0, i1)) = (span(wl, wr, ink_x, out_w), span(wt, wb, ink_y, h));
        if j0 >= j1 || i0 >= i1 {
            return None;
        }
        let source = |j: usize| if squeeze == 1.0 { j } else { ((j as f64 / squeeze).floor() as usize).min(w - 1) };
        let (s0, s1) = (source(j0), source(j1 - 1) + 1);
        let (sw, rows) = (s1 - s0, i1 - i0);
        let (left, top) = (x0 + s0 as f64, y0 + i0 as f64);
        let mut bytes = vec![0u8; sw * rows];
        let _ = crate::canvas::cover_rings(rings, false, sw, rows, (-left, -top), &mut |x, y, c| bytes[y * sw + x] = (c * 255.0).round() as u8);
        // (…a bitmap glyph's alpha, sampled at each pixel's centre, where it covers more)
        for s in sprites {
            let (iw, ih) = (s.image.width(), s.image.height());
            for (py, row) in bytes.chunks_exact_mut(sw).enumerate() {
                let v = (top + py as f64 + 0.5 - s.top) / s.height;
                if !(0.0..1.0).contains(&v) {
                    continue;
                }
                for (px, cell) in row.iter_mut().enumerate() {
                    let u = (left + px as f64 + 0.5 - s.left) / s.width;
                    if (0.0..1.0).contains(&u) {
                        let a = s.image.get_pixel((u * f64::from(iw)) as u32, (v * f64::from(ih)) as u32)[0];
                        *cell = (*cell).max(a);
                    }
                }
            }
        }
        // (…condensed: each output column samples the source column it falls in, so a device pixel composites once)
        if squeeze != 1.0 {
            bytes = (0..rows).flat_map(|y| (j0..j1).map(move |j| (y, j))).map(|(y, j)| bytes[y * sw + source(j) - s0]).collect();
        }
        Some(Mask { x: ink_x as i64 + j0 as i64, y: ink_y as i64 + i0 as i64, width: j1 - j0, height: rows, bytes })
    }
}

// The fraction of the em square above the baseline: the face's typographic ascender over its ascender and descender
// (OS/2, else hhea) — None where they span nothing.
fn em_split(face: &Face) -> Option<f64> {
    use skrifa::raw::TableProvider;
    let font = face.font();
    let (asc, desc) = match font.os2() {
        Ok(os2) => (f64::from(os2.s_typo_ascender()), f64::from(os2.s_typo_descender())),
        Err(_) => font.hhea().ok().map(|h| (f64::from(h.ascender().to_i16()), f64::from(h.descender().to_i16())))?,
    };
    (asc - desc > 0.0).then(|| asc / (asc - desc))
}

// The hanging and ideographic baselines a face's `BASE` table gives (its horizontal axis, the DFLT or latn script, else
// its first), px above the alphabetic one at `size` — None where it has no table, or no coordinates.
fn base_baselines(face: &Face, size: f64) -> Option<(f64, f64)> {
    let (font, upem) = (face.font(), face.upem());
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

// __dom.canvasText(text, handle, size, kerning, smallCaps, rtl[, place]) -> the line `text` makes in the face `handle` at
// `size` px, on a right-to-left base direction where `rtl` (`line`): `{advance, inkLeft, inkRight, inkAscent,
// inkDescent, ascent, descent, emAscent, emDescent[, hangingBaseline, ideographicBaseline][, maskX, maskY, maskWidth,
// maskHeight, mask]}` — or null where the face is none native reads. `place`, a Float64Array `[anchorX, anchorY, align,
// baseline, maxWidth, windowLeft, windowTop, windowRight, windowBottom, shadowBlur]` (`Placement`; the baseline its
// `textBaseline`'s index), draws it too: the mask is what of it reaches the canvas, its left and top in device pixels,
// its bytes a Uint8Array of coverage.
fn canvas_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    let handle = args.get(1).int32_value(scope).unwrap_or(-1);
    let size = args.get(2).number_value(scope).unwrap_or(10.0);
    let [kerning, small_caps, rtl] = [3, 4, 5].map(|k| args.get(k).boolean_value(scope));
    let place = match *crate::dom::f64_arg(args.get(6)) {
        [ax, ay, align, baseline, max_width, wl, wt, wr, wb, shadow_blur] => Some(Placement {
            anchor: (ax, ay),
            align,
            baseline: Baseline::from_index(baseline as i32),
            max_width,
            window: [wl, wt, wr, wb],
            shadow_blur,
        }),
        _ => None,
    };
    let Some(line) = std::panic::catch_unwind(|| line(&text, handle, size, kerning, small_caps, rtl, place.as_ref())).ok().flatten() else { return rv.set_null() };
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
    if let Some(m) = &line.mask {
        numbers.extend([("maskX", m.x as f64), ("maskY", m.y as f64), ("maskWidth", m.width as f64), ("maskHeight", m.height as f64)]);
    }
    for (key, n) in numbers {
        let value = v8::Number::new(scope, n).into();
        set(scope, key, value);
    }
    if let Some(m) = line.mask {
        let mask = crate::dom::u8_array(scope, m.bytes);
        set(scope, "mask", mask);
    }
    rv.set(obj.into());
}
