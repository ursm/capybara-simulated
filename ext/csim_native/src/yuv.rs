// A decoded YUV picture converted to RGBA: by its matrix coefficients (ITU-T H.273's codes: BT.709, BT.601, BT.2020,
// or the planes themselves as GBR) and its range (limited, the TV range, or full), chroma upsampled to the nearest
// sample. What every video and AV1 decoder hands over (av1.rs, video.rs) comes through here.

// A picture's planes as a decoder hands them over: a sample a byte at 8 bits, two (little-endian) above; each plane's
// rows `stride` bytes apart; chroma subsampled by the shifts `ss` (1, 1 for 4:2:0); no chroma planes for monochrome.
pub(crate) struct Planes<'a> {
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) bit_depth: u32,
    pub(crate) ss: (usize, usize),
    pub(crate) y: (&'a [u8], usize),
    pub(crate) uv: Option<[(&'a [u8], usize); 2]>,
}

// How YUV maps to RGB (H.273 MatrixCoefficients): 0 GBR (no transform), 1 BT.709, 9 BT.2020 non-constant luminance;
// anything else BT.601 (5, 6), which is also what an untagged stream is read as (ffmpeg's and libavif's default).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Color {
    pub(crate) matrix: u32,
    pub(crate) full_range: bool,
}

impl Default for Color {
    fn default() -> Color {
        Color { matrix: 6, full_range: false }
    }
}

impl Planes<'_> {
    // Opaque RGBA, `width` × `height`; None where a plane is shorter than its rows say.
    pub(crate) fn rgba(&self, color: Color) -> Option<Vec<u8>> {
        let (w, h, bpc) = (self.width, self.height, self.bit_depth);
        let wide = bpc > 8;
        let max = f64::from((1u32 << bpc) - 1);
        let (cw, ch) = ((w + (1 << self.ss.0) - 1) >> self.ss.0, (h + (1 << self.ss.1) - 1) >> self.ss.1);
        let fits = |(data, stride): (&[u8], usize), pw: usize, ph: usize| ph == 0 || data.len() >= stride * (ph - 1) + pw * (1 + usize::from(wide));
        if !fits(self.y, w, h) || self.uv.is_some_and(|uv| !uv.iter().all(|&p| fits(p, cw, ch))) {
            return None;
        }
        let sample = |(data, stride): (&[u8], usize), x: usize, y: usize| -> f64 {
            if wide {
                let i = y * stride + 2 * x;
                f64::from(u16::from_le_bytes([data[i], data[i + 1]]))
            } else {
                f64::from(data[y * stride + x])
            }
        };
        let s = max / 255.0;
        let unit = |v: f64, luma: bool| match (color.full_range, luma) {
            (true, true) => v / max,
            (true, false) => (v - (max + 1.0) / 2.0) / max,
            (false, true) => (v - 16.0 * s) / (219.0 * s),
            (false, false) => (v - 128.0 * s) / (224.0 * s),
        };
        let (kr, kb) = match color.matrix {
            1 => (0.2126, 0.0722),
            9 => (0.2627, 0.0593),
            _ => (0.299, 0.114),
        };
        let byte = |v: f64| (v * 255.0).round().clamp(0.0, 255.0) as u8;
        let mut out = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                let luma = unit(sample(self.y, x, y), true);
                let (cx, cy) = (x >> self.ss.0, y >> self.ss.1);
                let [r, g, b] = match self.uv {
                    None => [luma; 3],
                    // (…GBR: the planes are the channels, each a full-range-style value)
                    Some([u, v]) if color.matrix == 0 => [unit(sample(v, cx, cy), true), luma, unit(sample(u, cx, cy), true)],
                    Some([u, v]) => {
                        let (cb, cr) = (unit(sample(u, cx, cy), false), unit(sample(v, cx, cy), false));
                        let r = luma + 2.0 * (1.0 - kr) * cr;
                        let b = luma + 2.0 * (1.0 - kb) * cb;
                        [r, (luma - kr * r - kb * b) / (1.0 - kr - kb), b]
                    }
                };
                out.extend([byte(r), byte(g), byte(b), 255]);
            }
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_by_matrix_and_range() {
        // (…BT.709 limited-range red, 4:2:0 at 2 × 2)
        let (y, u, v) = ([63u8; 4], [102u8], [240u8]);
        let p = Planes { width: 2, height: 2, bit_depth: 8, ss: (1, 1), y: (&y, 2), uv: Some([(&u, 1), (&v, 1)]) };
        let rgba = p.rgba(Color { matrix: 1, full_range: false }).unwrap();
        assert!(rgba[0] > 250 && rgba[1] < 5 && rgba[2] < 5, "{:?}", &rgba[..4]);
        // (…a plane shorter than its rows say is refused)
        let short = Planes { width: 4, height: 2, bit_depth: 8, ss: (1, 1), y: (&y, 4), uv: Some([(&u, 1), (&v, 1)]) };
        assert!(short.rgba(Color::default()).is_none());
    }
}
