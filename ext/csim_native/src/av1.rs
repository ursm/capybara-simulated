// AV1 decoded to RGBA: an AVIF image (its container read by avif-parse, its colour and alpha items each an AV1 key
// frame) — and the frame a video shows first. rav1d, the Rust port of dav1d, decodes; its YUV is converted here by the
// sequence header's matrix coefficients and range (BT.601 where it names none, as libavif reads it), chroma upsampled
// to the nearest sample.

use std::ptr::NonNull;

use rav1d::include::dav1d::data::Dav1dData;
use rav1d::include::dav1d::dav1d::{Dav1dContext, Dav1dSettings};
use rav1d::include::dav1d::headers::{
    DAV1D_COLOR_PRI_SMPTE432, DAV1D_MC_BT2020_NCL, DAV1D_MC_BT709, DAV1D_MC_IDENTITY, DAV1D_PIXEL_LAYOUT_I400,
    DAV1D_PIXEL_LAYOUT_I420, DAV1D_PIXEL_LAYOUT_I422,
};
use rav1d::include::dav1d::picture::Dav1dPicture;
use rav1d::src::lib::{
    dav1d_close, dav1d_data_create, dav1d_default_settings, dav1d_get_picture, dav1d_open, dav1d_picture_unref,
    dav1d_send_data,
};

use crate::image_decode::Bitmap;

// An AVIF file's still image: its colour item, and its alpha item where it has one (unpremultiplied where the file
// says it is premultiplied). Display P3 primaries are kept and tagged, as a P3-profiled raster is.
pub(crate) fn avif(bytes: &[u8]) -> Option<Bitmap> {
    let file = avif_parse::read_avif(&mut std::io::Cursor::new(bytes)).ok()?;
    let color = frame(&file.primary_item)?;
    let mut rgba = color.rgba;
    if let Some(alpha) = file.alpha_item.as_deref().and_then(frame).filter(|a| (a.width, a.height) == (color.width, color.height)) {
        for (px, a) in rgba.chunks_exact_mut(4).zip(alpha.rgba.chunks_exact(4)) {
            px[3] = a[0];
            if file.premultiplied_alpha && a[0] > 0 {
                [0, 1, 2].map(|c| px[c] = ((u32::from(px[c]) * 255 + u32::from(a[0]) / 2) / u32::from(a[0])).min(255) as u8);
            }
        }
    }
    let natural = crate::dom::NaturalSize::sized(f64::from(color.width), f64::from(color.height));
    Some(Bitmap { width: color.width, height: color.height, natural, rgba, rgba_p3: None, display_p3: color.display_p3 })
}

pub(crate) struct Frame {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgba: Vec<u8>,
    pub(crate) display_p3: bool,
}

// The first frame an AV1 bitstream (OBUs) decodes to, opaque RGBA.
pub(crate) fn frame(obus: &[u8]) -> Option<Frame> {
    Decoder::open()?.first_picture(obus).map(|p| p.rgba())
}

// A dav1d context, closed when dropped.
struct Decoder(Option<Dav1dContext>);

impl Decoder {
    fn open() -> Option<Decoder> {
        let mut settings = std::mem::MaybeUninit::<Dav1dSettings>::uninit();
        let mut ctx = None;
        // SAFETY: `settings` is written in full by `dav1d_default_settings` before it is read; `ctx` is written by
        // `dav1d_open`, and only read where it succeeded.
        unsafe {
            dav1d_default_settings(NonNull::new(settings.as_mut_ptr())?);
            let mut settings = settings.assume_init();
            settings.n_threads = 1;
            settings.max_frame_delay = 1;
            if dav1d_open(NonNull::new(&mut ctx), NonNull::new(&mut settings)).0 != 0 {
                return None;
            }
        }
        Some(Decoder(ctx))
    }

    // Feed `obus` until a picture comes out.
    fn first_picture(&self, obus: &[u8]) -> Option<Picture> {
        let mut data = Dav1dData::default();
        let mut picture = Picture(Dav1dPicture::default());
        // SAFETY: `data` owns the buffer `dav1d_data_create` allocates, `obus.len()` bytes, filled before it is sent;
        // the context is open; `picture` is written by `dav1d_get_picture` and unreferenced when dropped.
        unsafe {
            let buf = dav1d_data_create(NonNull::new(&mut data), obus.len());
            if buf.is_null() {
                return None;
            }
            std::ptr::copy_nonoverlapping(obus.as_ptr(), buf, obus.len());
            let again = -libc::EAGAIN;
            loop {
                let sent = if data.sz > 0 { dav1d_send_data(self.0.clone(), NonNull::new(&mut data)).0 } else { 0 };
                if sent != 0 && sent != again {
                    return None;
                }
                match dav1d_get_picture(self.0.clone(), NonNull::new(&mut picture.0)).0 {
                    0 => return Some(picture),
                    r if r == again && data.sz > 0 => continue,
                    _ => return None,
                }
            }
        }
    }
}
impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: the context came from `dav1d_open` and is closed once, here.
        unsafe { dav1d_close(NonNull::new(&mut self.0)) };
    }
}

// A decoded picture, unreferenced when dropped.
struct Picture(Dav1dPicture);

impl Drop for Picture {
    fn drop(&mut self) {
        // SAFETY: the picture was written by `dav1d_get_picture` (or is empty, which unref accepts).
        unsafe { dav1d_picture_unref(NonNull::new(&mut self.0)) };
    }
}

impl Picture {
    fn rgba(&self) -> Frame {
        let p = &self.0;
        let (w, h, bpc) = (p.p.w.max(0) as usize, p.p.h.max(0) as usize, p.p.bpc);
        // SAFETY: a picture `dav1d_get_picture` returned carries its sequence header.
        let seq = p.seq_hdr.map(|s| unsafe { s.as_ref() });
        let (mtrx, full, p3) = seq.map_or((0, false, false), |s| (s.mtrx, s.color_range != 0, s.pri == DAV1D_COLOR_PRI_SMPTE432));
        let (ssx, ssy) = match p.p.layout {
            DAV1D_PIXEL_LAYOUT_I420 => (1, 1),
            DAV1D_PIXEL_LAYOUT_I422 => (1, 0),
            _ => (0, 0),
        };
        let mono = p.p.layout == DAV1D_PIXEL_LAYOUT_I400;
        let max = f64::from((1u32 << bpc) - 1);
        // A sample of plane `k` at (x, y), as 0..=max.
        let sample = |k: usize, x: usize, y: usize| -> f64 {
            let Some(base) = p.data[k] else { return max / 2.0 };
            let stride = p.stride[usize::from(k > 0)];
            // SAFETY: (x, y) lies in plane `k`'s rows, `stride` bytes apart, of one byte a sample at 8 bits, two above.
            unsafe {
                let row = base.as_ptr().cast::<u8>().offset(y as isize * stride);
                if bpc > 8 { f64::from(*row.cast::<u16>().add(x)) } else { f64::from(*row.add(x)) }
            }
        };
        let (kr, kb) = match mtrx {
            DAV1D_MC_BT709 => (0.2126, 0.0722),
            DAV1D_MC_BT2020_NCL => (0.2627, 0.0593),
            _ => (0.299, 0.114),
        };
        let unit = |v: f64, luma: bool| -> f64 {
            let s = max / 255.0;
            match (full, luma) {
                (true, true) => v / max,
                (true, false) => (v - (max + 1.0) / 2.0) / max,
                (false, true) => (v - 16.0 * s) / (219.0 * s),
                (false, false) => (v - 128.0 * s) / (224.0 * s),
            }
        };
        let byte = |v: f64| (v * 255.0).round().clamp(0.0, 255.0) as u8;
        let mut rgba = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                let (cx, cy) = (x >> ssx, y >> ssy);
                let luma = unit(sample(0, x, y), true);
                let [r, g, b] = if mtrx == DAV1D_MC_IDENTITY {
                    // (…GBR: the planes are the channels)
                    [unit(sample(2, cx, cy), true), luma, unit(sample(1, cx, cy), true)]
                } else {
                    let (cb, cr) = if mono { (0.0, 0.0) } else { (unit(sample(1, cx, cy), false), unit(sample(2, cx, cy), false)) };
                    let kg = 1.0 - kr - kb;
                    let r = luma + 2.0 * (1.0 - kr) * cr;
                    let b = luma + 2.0 * (1.0 - kb) * cb;
                    [r, (luma - kr * r - kb * b) / kg, b]
                };
                rgba.extend([byte(r), byte(g), byte(b), 255]);
            }
        }
        Frame { width: w as u32, height: h as u32, rgba, display_p3: p3 }
    }
}
