// An image resource's bytes decoded to an RGBA bitmap (HTML §4.8.4.3, "update the image data": what an `<img>` shows,
// a pattern or drawImage source, createImageBitmap's Blob): the format sniffed from the bytes, as a browser sniffs an
// image (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF — the first frame of an animated one) with SVG as the fallback, turned
// as its EXIF orientation says (CSS `image-orientation: from-image`, the default), and its colours managed by its
// profile: a Display P3 one kept as it is and tagged, for the canvas to convert; any other but sRGB — CMYK, Adobe RGB,
// whatever a camera wrote — rendered twice, into sRGB and into Display P3, for a canvas of either space (one buffer
// cannot be both: gamut mapping into sRGB is not a clip of the P3 value).

use std::io::Cursor;
use std::sync::Arc;

use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use moxcms::{ColorProfile, DataColorSpace, Layout, RenderingIntent, TransformOptions};
use resvg::{tiny_skia, usvg};

use crate::dom::NaturalSize;

// The most pixels an image is decoded to: 2^27, 512 MB as RGBA — what a canvas backs (canvas.js `MAX_BITMAP_AREA`).
// A header claiming more is not believed into an allocation: the image loads at its size, with nothing to draw.
pub(crate) const MAX_AREA: u64 = 1 << 27;
pub(crate) fn fits(width: u32, height: u32) -> bool {
    u64::from(width) * u64::from(height) <= MAX_AREA
}

// A decoded image: its pixels — none where it has no area (an SVG `width="0"`), its data is corrupt past a header that
// gave its dimensions, or there are more than `MAX_AREA`: an image that loads, with nothing to draw (HTML: "available",
// not "fully decodable") — and the natural size the layout sizes an `<img>` of it from.
pub(crate) struct Bitmap {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) natural: NaturalSize,
    pub(crate) rgba: Vec<u8>,
    // The Display P3 rendering of a wide-gamut source, beside the sRGB one in `rgba`.
    pub(crate) rgba_p3: Option<Vec<u8>>,
    // Whether `rgba` holds Display P3 values (a P3-profiled image, kept as it is).
    pub(crate) display_p3: bool,
    // The EXIF orientation it was turned by (1: none), which createImageBitmap's `imageOrientation: "none"` undoes.
    pub(crate) orientation: u8,
}

impl Bitmap {
    // A raster image of `width` × `height` with nothing to draw.
    pub(crate) fn undrawable(width: u32, height: u32) -> Bitmap {
        let natural = NaturalSize::sized(f64::from(width), f64::from(height));
        Bitmap { width, height, natural, rgba: Vec::new(), rgba_p3: None, display_p3: false, orientation: 1 }
    }
}

pub(crate) enum Decoded {
    Bitmap(Bitmap),
    // No image: an unknown format, or corrupt.
    Broken,
}

// `bytes` decoded, shrunk to fit inside `fit` (width, height) where it is larger.
pub(crate) fn decode(bytes: &[u8], fit: Option<(u32, u32)>) -> Decoded {
    let decoded = match image::guess_format(bytes) {
        Ok(ImageFormat::Avif) => crate::av1::avif(bytes).ok_or(Decoded::Broken),
        Ok(ImageFormat::Jpeg) => jpeg(bytes),
        Ok(_) => raster(bytes),
        Err(_) => svg(bytes),
    };
    match decoded {
        Ok(b) => Decoded::Bitmap(match fit {
            Some((w, h)) => shrink_to_fit(b, w, h),
            None => b,
        }),
        Err(d) => d,
    }
}

// A raster format the `image` crate reads, turned and colour-managed.
fn raster(bytes: &[u8]) -> Result<Bitmap, Decoded> {
    let mut decoder = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_decoder().ok())
        .ok_or(Decoded::Broken)?;
    let icc = decoder.icc_profile().ok().flatten();
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (width, height) = decoder.dimensions();
    if !fits(width, height) {
        return Ok(Bitmap::undrawable(width, height));
    }
    // (…its header read and its data not: Chrome loads it, drawing nothing)
    let Ok(mut img) = DynamicImage::from_decoder(decoder) else { return Ok(Bitmap::undrawable(width, height)) };
    img.apply_orientation(orientation);
    let b = managed(img.width(), img.height(), img.into_rgba8().into_raw(), icc.as_deref(), false);
    Ok(Bitmap { orientation: orientation.to_exif(), ..b })
}

// A JPEG (zune-jpeg, straight to RGBA): turned, and colour-managed. One coded as CMYK or YCCK is read as its inks —
// YCCK, the CMY complement coded as YCbCr with K as it is, comes back as libjpeg hands it over (`255 - R, 255 - G,
// 255 - B, K`) — an Adobe file's stored inverted, which is put right, then through its profile (by the naive
// complement where it has none).
fn jpeg(bytes: &[u8]) -> Result<Bitmap, Decoded> {
    use zune_jpeg::zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions};
    // (…the header read whatever size it claims, JPEG's own limit; `MAX_AREA` decides what is decoded)
    let options = |out| DecoderOptions::default().set_max_width(usize::from(u16::MAX)).set_max_height(usize::from(u16::MAX)).jpeg_set_out_colorspace(out);
    let decoder_for = |out| zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(bytes), options(out));
    let mut decoder = decoder_for(ColorSpace::RGBA);
    decoder.decode_headers().map_err(|_| Decoded::Broken)?;
    let (width, height) = decoder.dimensions().map(|(w, h)| (w as u32, h as u32)).ok_or(Decoded::Broken)?;
    if !fits(width, height) {
        return Ok(Bitmap::undrawable(width, height));
    }
    let orientation = decoder.exif().and_then(|exif| Orientation::from_exif_chunk(exif)).unwrap_or(Orientation::NoTransforms);
    let input = decoder.input_colorspace();
    let inks = matches!(input, Some(ColorSpace::CMYK | ColorSpace::YCCK));
    if inks {
        decoder = decoder_for(if input == Some(ColorSpace::YCCK) { ColorSpace::YCCK } else { ColorSpace::CMYK });
    }
    let Ok(mut px) = decoder.decode() else { return Ok(Bitmap::undrawable(width, height)) };
    if input == Some(ColorSpace::YCCK) {
        for p in px.chunks_exact_mut(4) {
            let (y, cb, cr) = (f64::from(p[0]), f64::from(p[1]) - 128.0, f64::from(p[2]) - 128.0);
            let rgb = [y + 1.402 * cr, y - 0.344_136 * cb - 0.714_136 * cr, y + 1.772 * cb];
            for (c, v) in rgb.into_iter().enumerate() {
                p[c] = 255 - v.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    if inks && adobe_app14(bytes) {
        px.iter_mut().for_each(|v| *v = 255 - *v);
    }
    let icc = jpeg_icc(bytes);
    if inks && icc.as_deref().is_none_or(|icc| icc_space(icc) != Some(*b"CMYK")) {
        px = naive_cmyk(&px);
    }
    let b = managed(width, height, px, icc.as_deref(), inks);
    Ok(if orientation == Orientation::NoTransforms { b } else { turned(b, orientation) })
}
// `b` turned as an EXIF orientation says: its buffers, and its size with them.
fn turned(b: Bitmap, orientation: Orientation) -> Bitmap {
    let turn = |rgba: Vec<u8>| -> (u32, u32, Vec<u8>) {
        let mut img = DynamicImage::ImageRgba8(image::RgbaImage::from_raw(b.width, b.height, rgba).expect("a buffer its own size"));
        img.apply_orientation(orientation);
        (img.width(), img.height(), img.into_rgba8().into_raw())
    };
    let (width, height, rgba) = turn(b.rgba);
    let natural = NaturalSize::sized(f64::from(width), f64::from(height));
    Bitmap { width, height, natural, rgba, rgba_p3: b.rgba_p3.map(|p3| turn(p3).2), display_p3: b.display_p3, orientation: orientation.to_exif() }
}

// `pixels` (4 channels: RGBA, or CMYK where `inks`) as the bitmap its profile says they are: no profile, or sRGB's,
// kept as they are; Display P3's kept and tagged; any other rendered into sRGB and into Display P3. A profile is told
// by its primaries, not by its name (a v4 profile writes its name as UTF-16).
fn managed(width: u32, height: u32, pixels: Vec<u8>, icc: Option<&[u8]>, inks: bool) -> Bitmap {
    let natural = NaturalSize::sized(f64::from(width), f64::from(height));
    let plain = |rgba: Vec<u8>, display_p3: bool| Bitmap { width, height, natural, rgba, rgba_p3: None, display_p3, orientation: 1 };
    let Some(profile) = icc.and_then(|icc| ColorProfile::new_from_slice(icc).ok()) else { return plain(pixels, false) };
    let cmyk = profile.color_space == DataColorSpace::Cmyk;
    if cmyk != inks || !(cmyk || profile.color_space == DataColorSpace::Rgb) {
        return plain(pixels, false);
    }
    if !cmyk && same_primaries(&profile, &ColorProfile::new_display_p3()) {
        return plain(pixels, true);
    }
    if !cmyk && same_primaries(&profile, &ColorProfile::new_srgb()) {
        return plain(pixels, false);
    }
    let into = |dst: &ColorProfile| -> Option<Vec<u8>> {
        let options = TransformOptions { rendering_intent: RenderingIntent::RelativeColorimetric, ..Default::default() };
        let transform = profile.create_transform_8bit(Layout::Rgba, dst, Layout::Rgba, options).ok()?;
        let mut out = vec![0; pixels.len()];
        transform.transform(&pixels, &mut out).ok()?;
        // (…a CMYK source has no alpha: opaque; an RGB one keeps its own)
        out.chunks_exact_mut(4).zip(pixels.chunks_exact(4)).for_each(|(o, p)| o[3] = if cmyk { 255 } else { p[3] });
        Some(out)
    };
    match into(&ColorProfile::new_srgb()) {
        Some(rgba) => Bitmap { width, height, natural, rgba_p3: into(&ColorProfile::new_display_p3()), rgba, display_p3: false, orientation: 1 },
        // (…a profile we cannot transform by: the values as they are, CMYK by its naive complement)
        None if cmyk => plain(naive_cmyk(&pixels), false),
        None => plain(pixels, false),
    }
}
// Whether two RGB profiles have the same primaries (their colorants, to a thousandth).
fn same_primaries(a: &ColorProfile, b: &ColorProfile) -> bool {
    let close = |p: &moxcms::Xyzd, q: &moxcms::Xyzd| (p.x - q.x).abs() < 1e-3 && (p.y - q.y).abs() < 1e-3 && (p.z - q.z).abs() < 1e-3;
    close(&a.red_colorant, &b.red_colorant) && close(&a.green_colorant, &b.green_colorant) && close(&a.blue_colorant, &b.blue_colorant)
}
fn naive_cmyk(cmyk: &[u8]) -> Vec<u8> {
    cmyk.chunks_exact(4)
        .flat_map(|p| {
            let k = 255 - u32::from(p[3]);
            [0, 1, 2].map(|c| ((255 - u32::from(p[c])) * k / 255) as u8).into_iter().chain([255])
        })
        .collect()
}

// The data colour space an ICC profile's header names (`RGB `, `CMYK`, `GRAY`, …).
fn icc_space(icc: &[u8]) -> Option<[u8; 4]> {
    icc.get(16..20)?.try_into().ok()
}

// A JPEG's segments before its scan: each marker and its payload.
fn jpeg_segments(bytes: &[u8]) -> impl Iterator<Item = (u8, &[u8])> {
    let mut i = 2;
    std::iter::from_fn(move || {
        while bytes.get(i) == Some(&0xFF) && bytes.get(i + 1) == Some(&0xFF) {
            i += 1;
        }
        let marker = *bytes.get(i + 1).filter(|_| bytes.get(i) == Some(&0xFF))?;
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let len = usize::from(u16::from_be_bytes([*bytes.get(i + 2)?, *bytes.get(i + 3)?]));
        let payload = bytes.get(i + 4..i + 2 + len.max(2))?;
        i += 2 + len;
        Some((marker, payload))
    })
}
// Its ICC profile: the APP2 `ICC_PROFILE` chunks, in their order.
fn jpeg_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut chunks: Vec<(u8, &[u8])> = jpeg_segments(bytes)
        .filter(|(m, p)| *m == 0xE2 && p.starts_with(b"ICC_PROFILE\0") && p.len() > 14)
        .map(|(_, p)| (p[12], &p[14..]))
        .collect();
    chunks.sort_by_key(|c| c.0);
    (!chunks.is_empty()).then(|| chunks.into_iter().flat_map(|c| c.1.iter().copied()).collect())
}
// Whether it carries Adobe's APP14 segment, whose CMYK is stored inverted.
fn adobe_app14(bytes: &[u8]) -> bool {
    jpeg_segments(bytes).any(|(m, p)| m == 0xEE && p.starts_with(b"Adobe"))
}

// An SVG document, rasterised at its concrete size, rounded (`NaturalSize::concrete`: its root's `width` and `height`
// where they are absolute lengths, a missing one through the `viewBox`'s ratio, else 300 × 150 — Chrome's figures,
// measured). That size is written onto the root, so its own `viewBox` and `preserveAspectRatio` place the drawing in
// it, and a percentage resolves against it. One with no area (`width="0"`, a negative one) is an image still — with no
// pixels. It is an image: it loads nothing (`<image href>` to a file or a URL draws nothing; a `data:` one does), and
// its text is set in the faces fontconfig resolves its families to (`TextFonts`).
fn svg(bytes: &[u8]) -> Result<Bitmap, Decoded> {
    let text = std::str::from_utf8(bytes).map_err(|_| Decoded::Broken)?;
    let options = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let doc = roxmltree::Document::parse_with_options(text, options).map_err(|_| Decoded::Broken)?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" {
        return Err(Decoded::Broken);
    }
    // (…em and rem against the initial font size: an image's document has no other; a negative length is none)
    let length = |name: &str| root.attribute(name).and_then(|v| crate::walk::svg_length(v, 16.0, 16.0)).map(|v| v.max(0.0));
    let natural = NaturalSize { width: length("width"), height: length("height"), view_box: root.attribute("viewBox").and_then(crate::walk::view_box) };
    let (width, height) = natural.concrete();
    let (w, h) = (width.round() as u32, height.round() as u32);
    if w == 0 || h == 0 || !fits(w, h) {
        return Ok(Bitmap { width: w, height: h, natural, rgba: Vec::new(), rgba_p3: None, display_p3: false, orientation: 1 });
    }
    // (…the concrete size in place of the root's own `width` / `height`, ranges replaced from the last)
    let mut sized = text.to_owned();
    let mut edits: Vec<(std::ops::Range<usize>, String)> = ["width", "height"]
        .into_iter()
        .filter_map(|name| root.attributes().find(|a| a.name() == name && a.namespace().is_none()).map(|a| (a.range(), String::new())))
        .collect();
    let open = root.range().start + 1;
    let name_end = open + text[open..].find(|c: char| c.is_whitespace() || c == '/' || c == '>').unwrap_or(0);
    edits.push((name_end..name_end, format!(r#" width="{width}" height="{height}""#)));
    edits.sort_by_key(|(r, _)| std::cmp::Reverse(r.start));
    for (range, with) in edits {
        sized.replace_range(range, &with);
    }
    let fonts = TextFonts::default();
    let options = usvg::Options {
        font_family: fonts.standard.clone(),
        font_size: 16.0,
        fontdb: Arc::new(usvg::fontdb::Database::new()),
        font_resolver: fonts.resolver(),
        image_href_resolver: usvg::ImageHrefResolver { resolve_string: Box::new(|_, _| None), ..Default::default() },
        ..Default::default()
    };
    let tree = usvg::Tree::from_str(&sized, &options).map_err(|_| Decoded::Broken)?;
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or(Decoded::Broken)?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    // (…tiny-skia's pixels are premultiplied)
    let rgba = pixmap.pixels().iter().flat_map(|p| {
        let c = p.demultiply();
        [c.red(), c.green(), c.blue(), c.alpha()]
    });
    Ok(Bitmap { width: w, height: h, natural, rgba: rgba.collect(), rgba_p3: None, display_p3: false, orientation: 1 })
}

// The faces an SVG image's text is set in: each family resolved through fontconfig as a page's CSS family is
// (browser.rb `font_file_for_family`) — a generic by the family Chrome asks on its behalf, a named one accepted only
// where fontconfig has it or substitutes it strongly, the standard font (Times New Roman) after them all — and a
// character none of them has, by the face fontconfig finds for it. A face is read from its file when it is first used.
struct TextFonts {
    // The family Chrome's standard font resolves to here.
    standard: String,
}

impl Default for TextFonts {
    fn default() -> TextFonts {
        let standard = crate::fontconfig::font_match("Times New Roman").and_then(|(_, f)| f.into_iter().next()).unwrap_or_else(|| "serif".into());
        TextFonts { standard }
    }
}

impl TextFonts {
    fn resolver(&self) -> usvg::FontResolver<'static> {
        usvg::FontResolver {
            select_font: Box::new(|font, db| {
                let pattern = |family: &str| format!("{}:weight={}:slant={}", fc_escape(family), fc_weight(font.weight()), fc_slant(font.style()));
                let names = font.families().iter().map(|f| match f {
                    usvg::FontFamily::Serif => ("Times New Roman".to_owned(), true),
                    usvg::FontFamily::SansSerif => ("Arial".to_owned(), true),
                    usvg::FontFamily::Cursive => ("Comic Sans MS".to_owned(), true),
                    usvg::FontFamily::Fantasy => ("Impact".to_owned(), true),
                    usvg::FontFamily::Monospace => ("monospace".to_owned(), true),
                    usvg::FontFamily::Named(s) => (s.clone(), false),
                });
                let file = names.chain([("Times New Roman".to_owned(), true)]).find_map(|(name, generic)| {
                    let (file, families) = crate::fontconfig::font_match(&pattern(&name))?;
                    let has = |n: &str| families.iter().any(|f| f.eq_ignore_ascii_case(n));
                    (generic || has(&name) || crate::fontconfig::strong_families(&fc_escape(&name)).iter().any(|s| has(s))).then_some(file)
                })?;
                face_of(db, &file)
            }),
            select_fallback: Box::new(|c, used, db| {
                let (file, _) = crate::fontconfig::font_match(&format!(":charset={:x}", u32::from(c)))?;
                face_of(db, &file).filter(|id| !used.contains(id))
            }),
        }
    }
}
// The face of `file` in `db`, read into it the first time.
fn face_of(db: &mut Arc<usvg::fontdb::Database>, file: &str) -> Option<usvg::fontdb::ID> {
    let path = std::path::Path::new(file);
    let find = |db: &usvg::fontdb::Database| db.faces().find(|f| matches!(&f.source, usvg::fontdb::Source::File(p) if p == path)).map(|f| f.id);
    if let Some(id) = find(db) {
        return Some(id);
    }
    Arc::make_mut(db).load_font_file(path).ok()?;
    find(db)
}
// fontconfig's pattern syntax, escaped out of a family name (`-`, `:` and `,` are pattern syntax).
fn fc_escape(family: &str) -> String {
    family.chars().flat_map(|c| if matches!(c, '-' | ':' | ',' | '\\') { vec!['\\', c] } else { vec![c] }).collect()
}
// A CSS weight on fontconfig's scale (FcWeightFromOpenType's breakpoints).
fn fc_weight(css: u16) -> u32 {
    match css {
        ..=150 => 0,
        151..=250 => 40,
        251..=350 => 50,
        351..=450 => 80,
        451..=550 => 100,
        551..=650 => 180,
        651..=750 => 200,
        751..=850 => 205,
        _ => 210,
    }
}
fn fc_slant(style: usvg::FontStyle) -> u32 {
    match style {
        usvg::FontStyle::Normal => 0,
        usvg::FontStyle::Italic => 100,
        usvg::FontStyle::Oblique => 110,
    }
}

// `b` scaled down (Lanczos3) to fit inside `max_w` × `max_h`, its aspect ratio kept.
fn shrink_to_fit(b: Bitmap, max_w: u32, max_h: u32) -> Bitmap {
    let shrink = (f64::from(b.width) / f64::from(max_w)).max(f64::from(b.height) / f64::from(max_h));
    if max_w == 0 || max_h == 0 || b.rgba.is_empty() || shrink <= 1.0 {
        return b;
    }
    let (w, h) = (((f64::from(b.width) / shrink).round() as u32).max(1), ((f64::from(b.height) / shrink).round() as u32).max(1));
    let scale = |rgba: Vec<u8>| -> Vec<u8> {
        let img = image::RgbaImage::from_raw(b.width, b.height, rgba).expect("a buffer its own size");
        image::imageops::resize(&img, w, h, image::imageops::FilterType::Lanczos3).into_raw()
    };
    Bitmap { width: w, height: h, rgba: scale(b.rgba), rgba_p3: b.rgba_p3.map(scale), ..b }
}

impl Bitmap {
    // Its natural size as four numbers — width, height, view box width and height — NaN for one it has not.
    fn natural_numbers(&self) -> [f64; 4] {
        let n = self.natural;
        let (vw, vh) = n.view_box.map_or((None, None), |(w, h)| (Some(w), Some(h)));
        [n.width, n.height, vw, vh].map(|v| v.unwrap_or(f64::NAN))
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "decodeImage", decode_image, context_id);
    crate::dom::register(scope, ns, "unorientImage", unorient_image, context_id);
}

// __dom.unorientImage(pixels, width, height, orientation) -> `{width, height, pixels}`: a decoded image (RGBA, a
// Uint8ClampedArray) as it was before the EXIF `orientation` turned it (createImageBitmap's `imageOrientation:
// "none"`) — the inverse turn, which is the same one but for the two quarter turns (6 and 8, each the other's).
fn unorient_image(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [w, h, exif] = [1, 2, 3].map(|k| args.get(k).uint32_value(scope).unwrap_or(0));
    let inverse = match exif {
        6 => 8,
        8 => 6,
        n => n as u8,
    };
    let Some(orientation) = Orientation::from_exif(inverse) else { return };
    let Some(pixels) = crate::canvas::bytes_read(args.get(0), None) else { return };
    let need = (w as usize).checked_mul(h as usize).and_then(|n| n.checked_mul(4));
    let Some(rgba) = need.and_then(|n| pixels.get(..n)).map(<[u8]>::to_vec) else { return };
    let Some(img) = image::RgbaImage::from_raw(w, h, rgba) else { return };
    let mut img = DynamicImage::ImageRgba8(img);
    img.apply_orientation(orientation);
    let obj = v8::Object::new(scope);
    let (width, height) = (v8::Integer::new_from_unsigned(scope, img.width()).into(), v8::Integer::new_from_unsigned(scope, img.height()).into());
    let pixels = crate::dom::u8_clamped_array(scope, img.into_rgba8().into_raw());
    for (key, value) in [("width", width), ("height", height), ("pixels", pixels)] {
        let key = v8::String::new(scope, key).expect("a short string");
        obj.set(scope, key.into(), value);
    }
    rv.set(obj.into());
}

// __dom.decodeImage(bytes, maxW, maxH) -> an encoded image (a Uint8Array) decoded on the page's own thread (`decode`;
// createImageBitmap's Blob, a service worker's image response): `{width, height, natural, colorSpace, pixels
// [, pixelsP3]}` — `natural` its natural size as `[width, height, viewBoxWidth, viewBoxHeight]` (NaN for one it has
// not), `pixels` a Uint8ClampedArray, RGBA — or for one with no pixels (`Bitmap`) `{width, height, natural, noPixels:
// true}`; null for no image. `maxW` / `maxH` 0 for no limit.
fn decode_image(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [max_w, max_h] = [1, 2].map(|k| args.get(k).uint32_value(scope).unwrap_or(0));
    let fit = (max_w > 0 && max_h > 0).then_some((max_w, max_h));
    let decoded = crate::canvas::bytes_read(args.get(0), None).map_or(Decoded::Broken, |bytes| {
        std::panic::catch_unwind(|| decode(&bytes, fit)).unwrap_or(Decoded::Broken)
    });
    let Decoded::Bitmap(b) = decoded else { return rv.set_null() };
    let obj = v8::Object::new(scope);
    let set = |scope: &mut v8::PinScope<'_, '_>, key: &str, value: v8::Local<'_, v8::Value>| {
        let key = v8::String::new(scope, key).expect("a short string");
        obj.set(scope, key.into(), value);
    };
    let (w, h) = (v8::Integer::new_from_unsigned(scope, b.width).into(), v8::Integer::new_from_unsigned(scope, b.height).into());
    set(scope, "width", w);
    set(scope, "height", h);
    let natural = crate::dom::f64_array(scope, &b.natural_numbers()).into();
    set(scope, "natural", natural);
    let orientation = v8::Integer::new(scope, i32::from(b.orientation)).into();
    set(scope, "orientation", orientation);
    if b.rgba.is_empty() {
        let yes = v8::Boolean::new(scope, true).into();
        set(scope, "noPixels", yes);
    } else {
        let space = v8::String::new(scope, if b.display_p3 { "display-p3" } else { "srgb" }).expect("a short string").into();
        set(scope, "colorSpace", space);
        let pixels = crate::dom::u8_clamped_array(scope, b.rgba);
        set(scope, "pixels", pixels);
        if let Some(p3) = b.rgba_p3 {
            let p3 = crate::dom::u8_clamped_array(scope, p3);
            set(scope, "pixelsP3", p3);
        }
    }
    rv.set(obj.into());
}

// Capybara::Simulated::Native.decode_image(bytes, max_w, max_h) -> `{'width', 'height', 'natural', 'colorSpace',
// 'bytes'[, 'bytesP3']}` (as `__dom.decodeImage`'s, `bytes` packed RGBA as a String), `{'width', 'height', 'natural',
// 'noPixels' => true}` for one with no pixels, or nil for no image. `max_w` / `max_h` 0 for no limit. The decode runs
// without the GVL — an image is decoded on the thread that fetched it, beside the others in flight — and a decoder
// that panics on a corrupt file has decoded no image.
pub(crate) fn decode_for_ruby(ruby: &magnus::Ruby, bytes: magnus::RString, max_w: u32, max_h: u32) -> Result<magnus::Value, magnus::Error> {
    use magnus::IntoValue;
    // SAFETY: the bytes are copied out before the GVL is released, and nothing else reads the string meanwhile.
    let bytes = unsafe { bytes.as_slice() }.to_vec();
    let fit = (max_w > 0 && max_h > 0).then_some((max_w, max_h));
    let decoded = without_gvl(|| std::panic::catch_unwind(|| decode(&bytes, fit)).unwrap_or(Decoded::Broken));
    let Decoded::Bitmap(b) = decoded else { return Ok(ruby.qnil().into_value_with(ruby)) };
    let hash = ruby.hash_new();
    hash.aset("width", b.width)?;
    hash.aset("height", b.height)?;
    hash.aset("natural", ruby.ary_from_vec(b.natural_numbers().to_vec()))?;
    hash.aset("orientation", b.orientation)?;
    if b.rgba.is_empty() {
        hash.aset("noPixels", true)?;
    } else {
        hash.aset("colorSpace", if b.display_p3 { "display-p3" } else { "srgb" })?;
        hash.aset("bytes", ruby.str_from_slice(&b.rgba))?;
        if let Some(p3) = b.rgba_p3 {
            hash.aset("bytesP3", ruby.str_from_slice(&p3))?;
        }
    }
    Ok(hash.into_value_with(ruby))
}
// `f` run with the GVL released, so other Ruby threads go on meanwhile.
fn without_gvl<F: FnOnce() -> R, R>(f: F) -> R {
    struct Job<F, R> {
        f: Option<F>,
        r: Option<R>,
    }
    unsafe extern "C" fn run<F: FnOnce() -> R, R>(data: *mut std::ffi::c_void) -> *mut std::ffi::c_void {
        // SAFETY: `data` is the `Job` below, alive for the call.
        let job = unsafe { &mut *data.cast::<Job<F, R>>() };
        job.r = Some((job.f.take().expect("run once"))());
        std::ptr::null_mut()
    }
    let mut job = Job { f: Some(f), r: None };
    // SAFETY: `run` is handed its own `Job`, and touches no Ruby object.
    unsafe {
        rb_sys::rb_thread_call_without_gvl(Some(run::<F, R>), (&raw mut job).cast(), None, std::ptr::null_mut());
    }
    job.r.expect("the job ran")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_an_svg_as_chrome_does() {
        let size = |svg: &str| match decode(svg.as_bytes(), None) {
            Decoded::Bitmap(b) => Some((b.width, b.height)),
            _ => None,
        };
        let ns = r#"xmlns="http://www.w3.org/2000/svg""#;
        assert_eq!(size(&format!("<svg {ns}><rect width='10' height='10'/></svg>")), Some((300, 150)));
        assert_eq!(size(&format!("<svg {ns} viewBox='0 0 40 20'/>")), Some((300, 150)));
        assert_eq!(size(&format!("<svg {ns} width='30'/>")), Some((30, 150)));
        assert_eq!(size(&format!("<svg {ns} width='50%' height='20'/>")), Some((300, 20)));
        assert_eq!(size(&format!("<svg {ns} width='0' height='10'/>")), Some((0, 10)));
        // (…absolute units, an exponent, a rounded fraction, a negative length as none)
        assert_eq!(size(&format!("<svg {ns} width='1in' height='2cm'/>")), Some((96, 76)));
        assert_eq!(size(&format!("<svg {ns} width='1e2' height='+40'/>")), Some((100, 40)));
        assert_eq!(size(&format!("<svg {ns} width='10.5' height='20.4'/>")), Some((11, 20)));
        assert_eq!(size(&format!("<svg {ns} width='-5' height='10'/>")), Some((0, 10)));
        assert!(matches!(decode(b"not an image", None), Decoded::Broken));
        // (…a PNG whose data is corrupt past its header: its size, no pixels)
        let bad = std::fs::read("../../spec/wpt/images/undecodable.png").unwrap();
        assert!(matches!(decode(&bad, None), Decoded::Bitmap(b) if (b.width, b.height) == (100, 50) && b.rgba.is_empty()));
    }

    #[test]
    fn believes_no_header_into_an_allocation() {
        // (…a 1 × 1 PNG whose header says 60000 × 60000: its size, nothing drawn — no 14 GB buffer)
        let mut png = Vec::new();
        image::RgbaImage::new(1, 1).write_to(&mut Cursor::new(&mut png), ImageFormat::Png).expect("a PNG");
        png[16..24].copy_from_slice(&[0, 0, 0xEA, 0x60, 0, 0, 0xEA, 0x60]);
        let crc = crc32(&png[12..29]);
        png[29..33].copy_from_slice(&crc.to_be_bytes());
        assert!(matches!(decode(&png, None), Decoded::Bitmap(b) if (b.width, b.height) == (60000, 60000) && b.rgba.is_empty()));
        let huge = r#"<svg xmlns="http://www.w3.org/2000/svg" width="500000000" height="1000"/>"#;
        assert!(matches!(decode(huge.as_bytes(), None), Decoded::Bitmap(b) if b.rgba.is_empty()));
    }
    fn crc32(bytes: &[u8]) -> u32 {
        !bytes.iter().fold(!0u32, |crc, &b| (0..8).fold(crc ^ u32::from(b), |c, _| if c & 1 == 1 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 }))
    }

    #[test]
    fn draws_an_svg_as_an_image() {
        let px = |svg: &str, x: u32, y: u32| match decode(svg.as_bytes(), None) {
            Decoded::Bitmap(b) => b.rgba[((y * b.width + x) * 4) as usize..][..4].to_vec(),
            Decoded::Broken => panic!("an image"),
        };
        let ns = r#"xmlns="http://www.w3.org/2000/svg""#;
        // (…no size, no view box: a percentage against the default object size, the whole of it)
        assert_eq!(px(&format!("<svg {ns}><rect width='100%' height='100%' fill='blue'/></svg>"), 299, 149), [0, 0, 255, 255]);
        // (…text in whatever face fontconfig gives its generic family)
        let text = format!("<svg {ns} width='60' height='40'><text x='0' y='30' font-family='sans-serif'>HH</text></svg>");
        assert!(matches!(decode(text.as_bytes(), None), Decoded::Bitmap(b) if b.rgba.chunks_exact(4).any(|p| p[3] > 128)));
        // (…a file it names draws nothing)
        let file = format!("<svg {ns} width='4' height='4'><image href='/etc/passwd' width='4' height='4'/></svg>");
        assert_eq!(px(&file, 1, 1), [0, 0, 0, 0]);
    }

    #[test]
    fn decodes_an_adobe_ycck_jpeg_through_its_profile() {
        // (…WPT's Generic CMYK cyan: C 100%)
        let bytes = std::fs::read("../../spec/wpt/html/canvas/element/manual/wide-gamut-canvas/resources/Generic-CMYK-FF000000.jpg").unwrap();
        let Decoded::Bitmap(b) = decode(&bytes, None) else { panic!("a bitmap") };
        let [r, g, bl] = [b.rgba[0], b.rgba[1], b.rgba[2]];
        assert!(r < 64 && g > 128 && bl > 192 && b.rgba_p3.is_some(), "{:?}", &b.rgba[..4]);
    }

    #[test]
    fn decodes_a_png_and_shrinks_it_to_fit() {
        let mut png = Vec::new();
        image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255])).write_to(&mut Cursor::new(&mut png), ImageFormat::Png).expect("a PNG");
        let Decoded::Bitmap(b) = decode(&png, Some((2, 8))) else { panic!("a bitmap") };
        assert_eq!((b.width, b.height, &b.rgba[..4]), (2, 2, &[255, 0, 0, 255][..]));
    }
}
