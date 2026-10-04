// AV1 decoded to RGBA: an AVIF image (its container read by avif-parse, its colour and alpha items each an AV1 key
// frame) — and the frame a video shows first. rav1d, the Rust port of dav1d, decodes; its YUV converts (yuv.rs) by the
// sequence header's matrix coefficients and range.

use std::ptr::NonNull;

use rav1d::include::dav1d::data::Dav1dData;
use rav1d::include::dav1d::dav1d::{Dav1dContext, Dav1dSettings};
use rav1d::include::dav1d::headers::{DAV1D_COLOR_PRI_SMPTE432, DAV1D_PIXEL_LAYOUT_I400, DAV1D_PIXEL_LAYOUT_I420, DAV1D_PIXEL_LAYOUT_I422};
use rav1d::include::dav1d::picture::Dav1dPicture;
use rav1d::src::lib::{
    dav1d_close, dav1d_data_create, dav1d_data_unref, dav1d_default_settings, dav1d_get_picture, dav1d_open,
    dav1d_picture_unref, dav1d_send_data,
};

use crate::image_decode::Bitmap;

// An AVIF file's still image: its colour item, and its alpha item where it has one (unpremultiplied where the file
// says it is premultiplied). Display P3 primaries are kept and tagged, as a P3-profiled raster is. One whose sequence
// header claims more than `MAX_AREA` pixels loads at that size with nothing to draw, as any image does.
pub(crate) fn avif(bytes: &[u8]) -> Option<Bitmap> {
    let file = avif_parse::read_avif(&mut std::io::Cursor::new(bytes)).ok()?;
    let size = file.primary_item_metadata().ok()?;
    let (w, h) = (size.max_frame_width.get(), size.max_frame_height.get());
    if !crate::image_decode::fits(w, h) {
        return Some(Bitmap::undrawable(w, h));
    }
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
    Some(Bitmap { width: color.width, height: color.height, natural, rgba, rgba_p3: None, display_p3: color.display_p3, orientation: 1 })
}

pub(crate) struct Frame {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgba: Vec<u8>,
    pub(crate) display_p3: bool,
}

// The first frame an AV1 bitstream (OBUs) decodes to, opaque RGBA.
pub(crate) fn frame(obus: &[u8]) -> Option<Frame> {
    Decoder::open()?.first_picture(obus)?.rgba()
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
            // (…a header claiming more pixels than an image may have is refused, not allocated for)
            settings.frame_size_limit = crate::image_decode::MAX_AREA as u32;
            if dav1d_open(NonNull::new(&mut ctx), NonNull::new(&mut settings)).0 != 0 {
                return None;
            }
        }
        Some(Decoder(ctx))
    }

    // Feed `obus` until a picture comes out.
    fn first_picture(&self, obus: &[u8]) -> Option<Picture> {
        let mut data = Data(Dav1dData::default());
        let mut picture = Picture(Dav1dPicture::default());
        // SAFETY: `data` owns the buffer `dav1d_data_create` allocates, `obus.len()` bytes, filled before it is sent,
        // and unreferenced when dropped; the context is open; `picture` is written by `dav1d_get_picture` and
        // unreferenced when dropped.
        unsafe {
            let buf = dav1d_data_create(NonNull::new(&mut data.0), obus.len());
            if buf.is_null() {
                return None;
            }
            std::ptr::copy_nonoverlapping(obus.as_ptr(), buf, obus.len());
            let again = -libc::EAGAIN;
            loop {
                let sent = if data.0.sz > 0 { dav1d_send_data(self.0.clone(), NonNull::new(&mut data.0)).0 } else { 0 };
                if sent != 0 && sent != again {
                    return None;
                }
                match dav1d_get_picture(self.0.clone(), NonNull::new(&mut picture.0)).0 {
                    0 => return Some(picture),
                    r if r == again && data.0.sz > 0 => continue,
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

// Data handed to the decoder, unreferenced when dropped (what it has not taken yet: what it took, it emptied).
struct Data(Dav1dData);

impl Drop for Data {
    fn drop(&mut self) {
        // SAFETY: data `dav1d_data_create` filled (or empty, which unref accepts), unreferenced once, here.
        unsafe { dav1d_data_unref(NonNull::new(&mut self.0)) };
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
    fn rgba(&self) -> Option<Frame> {
        let p = &self.0;
        let (w, h) = (p.p.w.max(0) as usize, p.p.h.max(0) as usize);
        // SAFETY: a picture `dav1d_get_picture` returned carries its sequence header.
        let seq = p.seq_hdr.map(|s| unsafe { s.as_ref() });
        let color = seq.map_or_else(Default::default, |s| crate::yuv::Color { matrix: s.mtrx, full_range: s.color_range != 0 });
        let ss = match p.p.layout {
            DAV1D_PIXEL_LAYOUT_I420 => (1, 1),
            DAV1D_PIXEL_LAYOUT_I422 => (1, 0),
            _ => (0, 0),
        };
        // A plane's rows, `stride` bytes apart.
        let plane = |k: usize, rows: usize| -> Option<(&[u8], usize)> {
            let stride = usize::try_from(p.stride[usize::from(k > 0)]).ok()?;
            // SAFETY: dav1d allocates each plane `stride` bytes a row for its rows, alive while the picture is
            // referenced.
            Some((unsafe { std::slice::from_raw_parts(p.data[k]?.as_ptr().cast::<u8>(), stride * rows) }, stride))
        };
        let ch = (h + (1 << ss.1) - 1) >> ss.1;
        let uv = if p.p.layout == DAV1D_PIXEL_LAYOUT_I400 { None } else { Some([plane(1, ch)?, plane(2, ch)?]) };
        let planes = crate::yuv::Planes { width: w, height: h, bit_depth: p.p.bpc.max(8) as u32, ss, y: plane(0, h)?, uv };
        let display_p3 = seq.is_some_and(|s| s.pri == DAV1D_COLOR_PRI_SMPTE432);
        Some(Frame { width: w as u32, height: h as u32, rgba: planes.rgba(color)?, display_p3 })
    }
}
