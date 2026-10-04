// An image resource's bytes decoded to an RGBA bitmap (HTML §4.8.4.3, "update the image data": what an `<img>` shows,
// a pattern or drawImage source, createImageBitmap's Blob): the format sniffed from the bytes, as a browser sniffs an
// image (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF — the first frame of an animated one) with SVG as the fallback, and its
// colours managed: a Display P3 image kept as it is and tagged, for the canvas to convert; a CMYK or Adobe RGB one
// rendered twice, into sRGB and into Display P3, for a canvas of either space (one buffer cannot be both: gamut mapping
// into sRGB is not a clip of the P3 value); any other kept as sRGB.

use std::io::Cursor;
use std::sync::{Arc, OnceLock};

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};

use crate::dom::NaturalSize;
use moxcms::{ColorProfile, Layout, RenderingIntent, TransformOptions};
use resvg::{tiny_skia, usvg};

// A decoded image: its pixels — none where it has no area (an SVG `width="0"`), or its data is corrupt past a header
// that gave its dimensions: an image that loads, with nothing to draw (HTML: "available", not "fully decodable") —
// and the natural size the layout sizes an `<img>` of it from.
pub(crate) struct Bitmap {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) natural: NaturalSize,
    pub(crate) rgba: Vec<u8>,
    // The Display P3 rendering of a wide-gamut source (CMYK, Adobe RGB), beside the sRGB one in `rgba`.
    pub(crate) rgba_p3: Option<Vec<u8>>,
    // Whether `rgba` holds Display P3 values (a P3-profiled image, kept as it is).
    pub(crate) display_p3: bool,
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
        Ok(ImageFormat::Jpeg) if icc_space(jpeg_icc(bytes).as_deref()) == Some(*b"CMYK") => cmyk_jpeg(bytes),
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

// A raster format the `image` crate reads, colour-managed by its embedded profile.
fn raster(bytes: &[u8]) -> Result<Bitmap, Decoded> {
    let mut decoder = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_decoder().ok())
        .ok_or(Decoded::Broken)?;
    let icc = decoder.icc_profile().ok().flatten();
    let (width, height) = decoder.dimensions();
    let Ok(img) = DynamicImage::from_decoder(decoder) else {
        // (…its header read and its data not: Chrome loads it, drawing nothing)
        let natural = NaturalSize::sized(f64::from(width), f64::from(height));
        return Ok(Bitmap { width, height, natural, rgba: Vec::new(), rgba_p3: None, display_p3: false });
    };
    Ok(managed(img.width(), img.height(), img.to_rgba8().into_raw(), icc.as_deref(), Layout::Rgba))
}

// A CMYK JPEG: its ink values, through its profile. They are stored as CMYK, or as YCCK — the CMY complement coded as
// YCbCr, K as it is — which comes back as libjpeg hands it over (`255 - R, 255 - G, 255 - B, K`); and an Adobe file's
// are stored inverted, which is put right.
fn cmyk_jpeg(bytes: &[u8]) -> Result<Bitmap, Decoded> {
    use zune_jpeg::zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions};
    let decoder_for = |out| zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(bytes), DecoderOptions::default().jpeg_set_out_colorspace(out));
    let mut decoder = decoder_for(ColorSpace::CMYK);
    decoder.decode_headers().map_err(|_| Decoded::Broken)?;
    let ycck = decoder.input_colorspace() == Some(ColorSpace::YCCK);
    if ycck {
        decoder = decoder_for(ColorSpace::YCCK);
    }
    let mut cmyk = decoder.decode().map_err(|_| Decoded::Broken)?;
    let (width, height) = decoder.dimensions().map(|(w, h)| (w as u32, h as u32)).ok_or(Decoded::Broken)?;
    if ycck {
        for px in cmyk.chunks_exact_mut(4) {
            let (y, cb, cr) = (f64::from(px[0]), f64::from(px[1]) - 128.0, f64::from(px[2]) - 128.0);
            let rgb = [y + 1.402 * cr, y - 0.344_136 * cb - 0.714_136 * cr, y + 1.772 * cb];
            for (c, v) in rgb.into_iter().enumerate() {
                px[c] = 255 - v.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    if adobe_app14(bytes) {
        cmyk.iter_mut().for_each(|v| *v = 255 - *v);
    }
    Ok(managed(width, height, cmyk, jpeg_icc(bytes).as_deref(), Layout::Rgba))
}

// `pixels` (4 channels: RGBA, or CMYK) as the bitmap its profile says they are.
fn managed(width: u32, height: u32, pixels: Vec<u8>, icc: Option<&[u8]>, layout: Layout) -> Bitmap {
    let natural = NaturalSize::sized(f64::from(width), f64::from(height));
    let plain = |rgba: Vec<u8>, display_p3: bool| Bitmap { width, height, natural, rgba, rgba_p3: None, display_p3 };
    let Some(icc) = icc else { return plain(pixels, false) };
    let cmyk = icc_space(Some(icc)) == Some(*b"CMYK");
    if !cmyk && (contains(icc, b"Display P3") || contains(icc, b"DCI-P3")) {
        return plain(pixels, true);
    }
    if !cmyk && !contains(icc, b"Adobe") {
        return plain(pixels, false);
    }
    let into = |dst: &ColorProfile| -> Option<Vec<u8>> {
        let src = ColorProfile::new_from_slice(icc).ok()?;
        let options = TransformOptions { rendering_intent: RenderingIntent::RelativeColorimetric, ..Default::default() };
        let transform = src.create_transform_8bit(layout, dst, Layout::Rgba, options).ok()?;
        let mut out = vec![0; pixels.len()];
        transform.transform(&pixels, &mut out).ok()?;
        // (…a CMYK source has no alpha: opaque)
        if cmyk {
            out.chunks_exact_mut(4).for_each(|p| p[3] = 255);
        }
        Some(out)
    };
    match into(&ColorProfile::new_srgb()) {
        Some(rgba) => Bitmap { width, height, natural, rgba_p3: into(&ColorProfile::new_display_p3()), rgba, display_p3: false },
        // (…a profile we cannot read: the values as they are, CMYK by its naive complement)
        None if cmyk => plain(naive_cmyk(&pixels), false),
        None => plain(pixels, false),
    }
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
fn icc_space(icc: Option<&[u8]>) -> Option<[u8; 4]> {
    icc?.get(16..20)?.try_into().ok()
}
fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
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

// An SVG document, rasterised at its concrete size (`NaturalSize::concrete`: its root's `width` and `height` where they
// are absolute lengths, a missing one through the `viewBox`'s ratio, else 300 × 150 — Chrome's figures, measured), its
// view box fitted into that, centred (`xMidYMid meet`). One with no area (`width="0"`) is an image still — with no
// pixels.
fn svg(bytes: &[u8]) -> Result<Bitmap, Decoded> {
    let text = std::str::from_utf8(bytes).map_err(|_| Decoded::Broken)?;
    let options = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let doc = roxmltree::Document::parse_with_options(text, options).map_err(|_| Decoded::Broken)?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" {
        return Err(Decoded::Broken);
    }
    // (…em and rem against the initial font size: an image's document has no other)
    let length = |name: &str| root.attribute(name).and_then(|v| crate::walk::svg_length(v, 16.0, 16.0));
    let natural = NaturalSize { width: length("width"), height: length("height"), view_box: root.attribute("viewBox").and_then(crate::walk::view_box) };
    let (width, height) = natural.concrete();
    let (w, h) = (width.ceil() as u32, height.ceil() as u32);
    if w == 0 || h == 0 {
        return Ok(Bitmap { width: w, height: h, natural, rgba: Vec::new(), rgba_p3: None, display_p3: false });
    }
    let options = usvg::Options { fontdb: system_fonts(), ..Default::default() };
    let tree = usvg::Tree::from_data(bytes, &options).map_err(|_| Decoded::Broken)?;
    let size = tree.size();
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or(Decoded::Broken)?;
    let s = (width as f32 / size.width()).min(height as f32 / size.height());
    let at = tiny_skia::Transform::from_row(s, 0.0, 0.0, s, (width as f32 - size.width() * s) / 2.0, (height as f32 - size.height() * s) / 2.0);
    resvg::render(&tree, at, &mut pixmap.as_mut());
    // (…tiny-skia's pixels are premultiplied)
    let rgba = pixmap.pixels().iter().flat_map(|p| {
        let c = p.demultiply();
        [c.red(), c.green(), c.blue(), c.alpha()]
    });
    Ok(Bitmap { width: w, height: h, natural, rgba: rgba.collect(), rgba_p3: None, display_p3: false })
}
// The system's fonts, for the text an SVG draws — read once, the first time an SVG is.
fn system_fonts() -> Arc<usvg::fontdb::Database> {
    static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    FONTS
        .get_or_init(|| {
            let mut db = usvg::fontdb::Database::new();
            db.load_system_fonts();
            Arc::new(db)
        })
        .clone()
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
    Bitmap { width: w, height: h, natural: b.natural, rgba: scale(b.rgba), rgba_p3: b.rgba_p3.map(scale), display_p3: b.display_p3 }
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
}

// __dom.decodeImage(bytes, maxW, maxH) -> an encoded image (a Uint8Array) decoded on the page's own thread (`decode`;
// createImageBitmap's Blob, a service worker's image response): `{width, height, natural, colorSpace, pixels
// [, pixelsP3]}` — `natural` its natural size as `[width, height, viewBoxWidth, viewBoxHeight]` (NaN for one it has
// not), `pixels` a Uint8ClampedArray, RGBA — or for one with no pixels (`Bitmap`) `{width, height, natural, noPixels: true}`; null
// for no image. `maxW` / `maxH` 0 for no limit.
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
        assert!(matches!(decode(b"not an image", None), Decoded::Broken));
        // (…a PNG whose data is corrupt past its header: its size, no pixels)
        let bad = std::fs::read("../../spec/wpt/images/undecodable.png").unwrap();
        assert!(matches!(decode(&bad, None), Decoded::Bitmap(b) if (b.width, b.height) == (100, 50) && b.rgba.is_empty()));
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
