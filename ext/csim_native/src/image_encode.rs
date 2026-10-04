// A bitmap serialised as an image file (HTML §4.12.5, "serialization of a bitmap as a file": `toDataURL`, `toBlob`,
// OffscreenCanvas `convertToBlob`, and the painter's screenshot): PNG, JPEG or WebP by the requested type, compared
// ASCII case-insensitively, any other type PNG. A format with no alpha channel (JPEG) is composited onto opaque
// black; a quality in [0, 1] is used where the format has one, else the UA default — Chrome's, 0.92 for JPEG and 0.8
// for WebP (measured). WebP is written lossless, so it has none. A Display P3 bitmap carries the Display P3 profile, as
// every one of the three formats can (§4.12.5.5: "the color space must be converted … or a profile embedded").

#[derive(Clone, Copy, PartialEq, Debug)]
enum Format {
    Png,
    Jpeg,
    Webp,
}

impl Format {
    // The format a requested type names — PNG for one we do not write, `image/jpg` among them (Chrome).
    fn of(mime: &str) -> Format {
        match mime.to_ascii_lowercase().as_str() {
            "image/jpeg" => Format::Jpeg,
            "image/webp" => Format::Webp,
            _ => Format::Png,
        }
    }
    fn mime(self) -> &'static str {
        match self {
            Format::Png => "image/png",
            Format::Jpeg => "image/jpeg",
            Format::Webp => "image/webp",
        }
    }
}

// `rgba` (`width` × `height`, unpremultiplied; Display P3 values where `p3`) as a file of `format`; None where the
// encoder refuses it.
fn encode(rgba: &[u8], width: u32, height: u32, format: Format, quality: f64, p3: bool) -> Option<Vec<u8>> {
    let icc = p3.then(display_p3_profile);
    let mut out = Vec::new();
    match format {
        Format::Png => {
            let mut info = png::Info::with_size(width, height);
            info.color_type = png::ColorType::Rgba;
            info.bit_depth = png::BitDepth::Eight;
            info.icc_profile = icc.map(std::borrow::Cow::Borrowed);
            png::Encoder::with_info(&mut out, info).ok()?.write_header().ok()?.write_image_data(rgba).ok()?;
        }
        Format::Jpeg => {
            let q = if (0.0..=1.0).contains(&quality) { quality } else { 0.92 };
            // (…onto black: each channel times its alpha)
            let rgb: Vec<u8> = rgba
                .chunks_exact(4)
                .flat_map(|p| {
                    let a = u32::from(p[3]);
                    [0, 1, 2].map(|c| ((u32::from(p[c]) * a + 127) / 255) as u8)
                })
                .collect();
            let mut enc = jpeg_encoder::Encoder::new(&mut out, (q * 100.0).round().clamp(1.0, 100.0) as u8);
            if let Some(icc) = icc {
                enc.add_icc_profile(icc).ok()?;
            }
            enc.encode(&rgb, u16::try_from(width).ok()?, u16::try_from(height).ok()?, jpeg_encoder::ColorType::Rgb).ok()?;
        }
        Format::Webp => {
            let mut enc = image_webp::WebPEncoder::new(&mut out);
            if let Some(icc) = icc {
                enc.set_icc_profile(icc.to_vec());
            }
            enc.encode(rgba, width, height, image_webp::ColorType::Rgba8).ok()?;
        }
    }
    Some(out)
}
// The Display P3 ICC profile, written once, its header as ICC.1 has it — which libpng checks: the size a multiple of
// four bytes ("including the pad bytes for the last tag"; a profile that is not one it drops), and the PCS illuminant
// D50 to the bit (0.9642, 1, 0.8249 as s15Fixed16; moxcms rounds its own D50 differently, which libpng warns of).
fn display_p3_profile() -> &'static [u8] {
    static PROFILE: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    PROFILE.get_or_init(|| {
        let mut icc = moxcms::ColorProfile::new_display_p3().encode().unwrap_or_default();
        if icc.len() < 128 {
            return Vec::new();
        }
        icc.resize(icc.len().next_multiple_of(4), 0);
        let len = u32::try_from(icc.len()).unwrap_or(0);
        icc[..4].copy_from_slice(&len.to_be_bytes());
        for (k, v) in [0x0000_F6D6_u32, 0x0001_0000, 0x0000_D32D].into_iter().enumerate() {
            icc[68 + 4 * k..72 + 4 * k].copy_from_slice(&v.to_be_bytes());
        }
        icc
    })
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "encodeImage", encode_image, context_id);
}

// __dom.encodeImage(pixels, width, height, type, quality, colorSpace) -> `[mime, bytes]`: the bitmap (`pixels` RGBA,
// a Uint8ClampedArray, in `colorSpace`: 'srgb' or 'display-p3') serialised as `type` asks (`encode`), the type it was
// written as, and its bytes; undefined where it could not be (too few pixels for its size, or a size the format
// cannot hold).
fn encode_image(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [w, h] = [1, 2].map(|k| args.get(k).uint32_value(scope).unwrap_or(0));
    let format = Format::of(&args.get(3).to_rust_string_lossy(scope));
    let quality = args.get(4).number_value(scope).unwrap_or(f64::NAN);
    let p3 = args.get(5).to_rust_string_lossy(scope) == "display-p3";
    let Some(pixels) = crate::canvas::bytes_read(args.get(0), None) else { return };
    let need = (w as usize).checked_mul(h as usize).and_then(|n| n.checked_mul(4));
    let Some(rgba) = need.and_then(|n| pixels.get(..n)) else { return };
    let Some(bytes) = encode(rgba, w, h, format, quality, p3) else { return };
    let mime = v8::String::new(scope, format.mime()).expect("a short string").into();
    let bytes = crate::dom::u8_array(scope, bytes);
    rv.set(v8::Array::new_with_elements(scope, &[mime, bytes]).into());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_format_it_writes() {
        assert_eq!(Format::of("IMAGE/JPEG"), Format::Jpeg);
        assert_eq!(Format::of("image/jpg"), Format::Png);
        assert_eq!(Format::of("image/bmp"), Format::Png);
    }

    #[test]
    fn writes_each_format() {
        let px = [255, 0, 0, 128].repeat(4);
        assert!(encode(&px, 2, 2, Format::Png, f64::NAN, false).unwrap().starts_with(b"\x89PNG"));
        assert!(encode(&px, 2, 2, Format::Jpeg, 2.0, false).unwrap().starts_with(&[0xFF, 0xD8]));
        assert_eq!(&encode(&px, 2, 2, Format::Webp, 0.5, false).unwrap()[8..12], b"WEBP");
        // (…a Display P3 bitmap carries its profile: PNG's `iCCP` chunk, JPEG's APP2, WebP's `ICCP` — a whole number of
        // four-byte words, its size field saying so)
        let icc = display_p3_profile();
        assert!(icc.len() % 4 == 0 && icc[..4] == u32::try_from(icc.len()).unwrap().to_be_bytes());
        assert_eq!(&icc[68..80], &[0, 0, 0xF6, 0xD6, 0, 1, 0, 0, 0, 0, 0xD3, 0x2D]);
        for (format, mark) in [(Format::Png, &b"iCCP"[..]), (Format::Jpeg, b"ICC_PROFILE"), (Format::Webp, b"ICCP")] {
            let file = encode(&px, 2, 2, format, f64::NAN, true).unwrap();
            assert!(file.windows(mark.len()).any(|w| w == mark), "{format:?}");
        }
    }
}
