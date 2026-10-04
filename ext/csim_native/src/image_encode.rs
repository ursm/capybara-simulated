// A bitmap serialised as an image file (HTML §4.12.5, "serialization of a bitmap as a file": `toDataURL`, `toBlob`,
// OffscreenCanvas `convertToBlob`, and the painter's screenshot): PNG, JPEG or WebP by the requested type, compared
// ASCII case-insensitively, any other type PNG. A format with no alpha channel (JPEG) is composited onto opaque
// black; a quality in [0, 1] is used where the format has one, else the UA default — Chrome's, 0.92 for JPEG and 0.8
// for WebP (measured). WebP is written lossless, so it has none.

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

// `rgba` (`width` × `height`, unpremultiplied) as a file of `format`; None where the encoder refuses it.
fn encode(rgba: &[u8], width: u32, height: u32, format: Format, quality: f64) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    match format {
        Format::Png => {
            let mut enc = png::Encoder::new(&mut out, width, height);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header().ok()?.write_image_data(rgba).ok()?;
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
            let enc = jpeg_encoder::Encoder::new(&mut out, (q * 100.0).round().clamp(1.0, 100.0) as u8);
            enc.encode(&rgb, u16::try_from(width).ok()?, u16::try_from(height).ok()?, jpeg_encoder::ColorType::Rgb).ok()?;
        }
        Format::Webp => {
            image_webp::WebPEncoder::new(&mut out).encode(rgba, width, height, image_webp::ColorType::Rgba8).ok()?;
        }
    }
    Some(out)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "encodeImage", encode_image, context_id);
}

// __dom.encodeImage(pixels, width, height, type, quality) -> `[mime, bytes]`: the bitmap (`pixels` RGBA, a
// Uint8ClampedArray) serialised as `type` asks (`encode`), the type it was written as, and its bytes; undefined where
// it could not be (too few pixels for its size, or a size the format cannot hold).
fn encode_image(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [w, h] = [1, 2].map(|k| args.get(k).uint32_value(scope).unwrap_or(0));
    let format = Format::of(&args.get(3).to_rust_string_lossy(scope));
    let quality = args.get(4).number_value(scope).unwrap_or(f64::NAN);
    let Some(pixels) = crate::canvas::bytes_read(args.get(0), None) else { return };
    let need = (w as usize).checked_mul(h as usize).and_then(|n| n.checked_mul(4));
    let Some(rgba) = need.and_then(|n| pixels.get(..n)) else { return };
    let Some(bytes) = encode(rgba, w, h, format, quality) else { return };
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
        assert!(encode(&px, 2, 2, Format::Png, f64::NAN).unwrap().starts_with(b"\x89PNG"));
        assert!(encode(&px, 2, 2, Format::Jpeg, 2.0).unwrap().starts_with(&[0xFF, 0xD8]));
        assert_eq!(&encode(&px, 2, 2, Format::Webp, 0.5).unwrap()[8..12], b"WEBP");
    }
}
