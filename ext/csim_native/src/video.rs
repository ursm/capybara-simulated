// A video resource's first frame (HTML §4.8.11, the media element: what `drawImage(video)` draws before playback, its
// `videoWidth` / `videoHeight` and `duration`): the container demuxed — MP4 (ISO BMFF, read here: its first video
// track's sample description, duration and first sample) or WebM / Matroska (matroska-demuxer) — and that sample, a
// key frame, decoded: H.264 by OpenH264, VP8 by image-webp's decoder, VP9 by rusty_vp9, AV1 by rav1d (av1.rs). Its YUV
// converts (yuv.rs) by the colour the container or the bitstream tags, BT.601 limited range where none does — as
// ffmpeg reads an untagged stream. A codec none of those is (HEVC, Theora) is a resource the media element cannot
// play: no video.

use std::io::Cursor;

use crate::yuv::{Color, Planes};

pub(crate) struct Video {
    pub(crate) width: u32,
    pub(crate) height: u32,
    // Seconds; 0 where the container gives none.
    pub(crate) duration: f64,
    pub(crate) rgba: Vec<u8>,
}

#[derive(Debug, PartialEq)]
enum Codec {
    // Its `avcC`: the parameter sets, and how many bytes a NAL unit's length takes.
    H264(Vec<u8>),
    // Its `av1C`'s configuration OBUs (the sequence header), which a sample need not repeat.
    Av1(Vec<u8>),
    Vp8,
    Vp9,
    Other,
}

// The first video track: what codes it, its size and duration, its first sample, and the colour the container tags.
struct Track {
    codec: Codec,
    width: u32,
    height: u32,
    duration: f64,
    sample: Vec<u8>,
    color: Option<Color>,
}

// `bytes` decoded to its first frame — None where it is no video we can play, or one larger than an image may be
// (`image_decode::MAX_AREA`, checked against the container's size and, before decoding, the bitstream's).
pub(crate) fn decode(bytes: &[u8]) -> Option<Video> {
    let track = if bytes.get(4..8) == Some(b"ftyp") { mp4(bytes)? } else { webm(bytes)? };
    if !crate::image_decode::fits(track.width, track.height) {
        return None;
    }
    let (width, height, rgba) = first_frame(&track)?;
    Some(Video { width, height, duration: track.duration, rgba })
}

fn first_frame(t: &Track) -> Option<(u32, u32, Vec<u8>)> {
    let color = |bitstream: Option<Color>| t.color.or(bitstream).unwrap_or_default();
    match &t.codec {
        Codec::H264(avcc) => {
            let mut decoder = openh264::decoder::Decoder::new().ok()?;
            let stream = annex_b(avcc, &t.sample)?;
            use openh264::formats::YUVSource;
            let frame = match decoder.decode(&stream).ok()? {
                Some(frame) => frame,
                None => decoder.flush_remaining().ok()?.into_iter().next()?,
            };
            let (w, h) = frame.dimensions();
            let (ys, us, vs) = frame.strides();
            let planes = Planes { width: w, height: h, bit_depth: 8, ss: (1, 1), y: (frame.y(), ys), uv: Some([(frame.u(), us), (frame.v(), vs)]) };
            Some((w as u32, h as u32, planes.rgba(color(None))?))
        }
        Codec::Av1(config) => {
            let obus = [config.as_slice(), &t.sample].concat();
            let frame = crate::av1::frame(&obus)?;
            Some((frame.width, frame.height, frame.rgba))
        }
        Codec::Vp8 => {
            // (…a key frame's size, 14 bits each, after its start code)
            let size = |at: usize| Some(u32::from(u16::from_le_bytes(t.sample.get(at..at + 2)?.try_into().ok()?) & 0x3FFF));
            if t.sample.get(3..6) != Some(&[0x9D, 0x01, 0x2A]) || !crate::image_decode::fits(size(6)?, size(8)?) {
                return None;
            }
            let frame = image_webp::vp8::Vp8Decoder::decode_frame(Cursor::new(&t.sample)).ok()?;
            let (w, h) = (usize::from(frame.width), usize::from(frame.height));
            // (…its planes are as wide as its macroblocks: the width rounded up to 16)
            let stride = w.next_multiple_of(16);
            let planes = Planes { width: w, height: h, bit_depth: 8, ss: (1, 1), y: (&frame.ybuf, stride), uv: Some([(&frame.ubuf, stride / 2), (&frame.vbuf, stride / 2)]) };
            Some((w as u32, h as u32, planes.rgba(color(None))?))
        }
        Codec::Vp9 => {
            let mut r = rusty_vp9::BitReader::new(&t.sample);
            let header = rusty_vp9::parse_uncompressed_header(&mut r, &[(0, 0); 8]).ok()?;
            if !crate::image_decode::fits(header.width, header.height) {
                return None;
            }
            let mut decoder = rusty_vp9::Vp9Decoder::new();
            decoder.push(&t.sample, None).ok()?;
            let frame = decoder.next_frame().or_else(|_| {
                decoder.flush();
                decoder.next_frame()
            });
            let frame = frame.ok()?;
            let (w, h) = (frame.width as usize, frame.height as usize);
            let uv = [(frame.planes.get(1)?.as_slice(), *frame.strides.get(1)?), (frame.planes.get(2)?.as_slice(), *frame.strides.get(2)?)];
            let planes = Planes { width: w, height: h, bit_depth: frame.bit_depth, ss: (frame.subsampling_x as usize, frame.subsampling_y as usize), y: (frame.planes.first()?, *frame.strides.first()?), uv: Some(uv) };
            Some((w as u32, h as u32, planes.rgba(color(vp9_color(&header)))?))
        }
        Codec::Other => None,
    }
}

// An H.264 sample as an Annex B stream OpenH264 reads: the `avcC`'s parameter sets, then the sample's NAL units, each
// behind a start code in place of its length.
fn annex_b(avcc: &[u8], sample: &[u8]) -> Option<Vec<u8>> {
    const START: [u8; 4] = [0, 0, 0, 1];
    let length_size = usize::from(*avcc.get(4)? & 3) + 1;
    let mut out = Vec::with_capacity(avcc.len() + sample.len() + 16);
    let mut i = 5;
    for mask in [0x1F, 0xFF] {
        let count = usize::from(*avcc.get(i)? & mask);
        i += 1;
        for _ in 0..count {
            let len = usize::from(u16::from_be_bytes([*avcc.get(i)?, *avcc.get(i + 1)?]));
            out.extend(START);
            out.extend_from_slice(avcc.get(i + 2..i + 2 + len)?);
            i += 2 + len;
        }
    }
    let mut j = 0;
    while j + length_size <= sample.len() {
        let len = sample[j..j + length_size].iter().fold(0usize, |n, &b| n << 8 | usize::from(b));
        out.extend(START);
        out.extend_from_slice(sample.get(j + length_size..j + length_size + len)?);
        j += length_size + len;
    }
    Some(out)
}

// A VP9 key frame's colour (its uncompressed header's color_space): BT.601, BT.709, BT.2020 or sRGB (GBR, full range);
// None for one it leaves unknown. (rusty_vp9 does not hand over the range bit after it: limited range, as nearly every
// VP9 stream is.)
fn vp9_color(header: &rusty_vp9::FrameHeader) -> Option<Color> {
    let matrix = match header.color_space {
        1 | 3 => 6,
        2 => 1,
        5 | 6 => 9,
        7 => 0,
        _ => return None,
    };
    Some(Color { matrix, full_range: matrix == 0 })
}

// ── MP4 (ISO BMFF) ──
// Its boxes in `data`: each type and payload (a 64-bit size where the 32-bit one is 1, to the end where it is 0).
fn boxes(data: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    let mut i = 0;
    std::iter::from_fn(move || {
        let header = data.get(i..i + 8)?;
        let size = u32::from_be_bytes(header[..4].try_into().ok()?) as u64;
        let kind: [u8; 4] = header[4..8].try_into().ok()?;
        let (start, size) = match size {
            1 => (i + 16, u64::from_be_bytes(data.get(i + 8..i + 16)?.try_into().ok()?)),
            0 => (i + 8, (data.len() - i) as u64),
            n => (i + 8, n),
        };
        let end = i.checked_add(usize::try_from(size).ok()?)?;
        let payload = data.get(start..end)?;
        i = end;
        Some((kind, payload))
    })
}
fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data).find(|(k, _)| k == kind).map(|(_, p)| p)
}
fn be32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

fn mp4(bytes: &[u8]) -> Option<Track> {
    let moov = child(bytes, b"moov")?;
    let trak = boxes(moov).filter(|(k, _)| k == b"trak").map(|(_, p)| p).find(|trak| {
        let hdlr = child(trak, b"mdia").and_then(|m| child(m, b"hdlr"));
        hdlr.and_then(|h| h.get(8..12)) == Some(b"vide")
    })?;
    let mdia = child(trak, b"mdia")?;
    let mdhd = child(mdia, b"mdhd")?;
    // (…version 1 is 64-bit times)
    let (timescale, duration) = if mdhd.first() == Some(&1) {
        (be32(mdhd, 20)?, u64::from_be_bytes(mdhd.get(24..32)?.try_into().ok()?))
    } else {
        (be32(mdhd, 12)?, u64::from(be32(mdhd, 16)?))
    };
    let stbl = child(child(mdia, b"minf")?, b"stbl")?;
    // The first sample description: a visual sample entry (78 bytes, its size at 24..28) and its boxes.
    let stsd = child(stbl, b"stsd")?;
    let (kind, entry) = boxes(stsd.get(8..)?).next()?;
    let (width, height) = (u32::from(u16::from_be_bytes(entry.get(24..26)?.try_into().ok()?)), u32::from(u16::from_be_bytes(entry.get(26..28)?.try_into().ok()?)));
    let inner = entry.get(78..)?;
    let codec = match &kind {
        b"avc1" | b"avc3" => Codec::H264(child(inner, b"avcC")?.to_vec()),
        b"av01" => Codec::Av1(child(inner, b"av1C")?.get(4..)?.to_vec()),
        b"vp08" => Codec::Vp8,
        b"vp09" => Codec::Vp9,
        _ => Codec::Other,
    };
    // `colr` as `nclx`: primaries, transfer, matrix, and the full-range flag.
    let color = child(inner, b"colr").filter(|c| c.get(..4) == Some(b"nclx")).and_then(|c| {
        Some(Color { matrix: u32::from(u16::from_be_bytes(c.get(8..10)?.try_into().ok()?)), full_range: c.get(10)? & 0x80 != 0 })
    });
    // The first sample: at its chunk's offset, its size the table's first (or the one size every sample has).
    let stsz = child(stbl, b"stsz")?;
    let size = match be32(stsz, 4)? {
        0 => be32(stsz, 12)?,
        n => n,
    } as usize;
    let offset = match child(stbl, b"stco") {
        Some(stco) => u64::from(be32(stco, 8)?),
        None => u64::from_be_bytes(child(stbl, b"co64")?.get(8..16)?.try_into().ok()?),
    } as usize;
    let sample = bytes.get(offset..offset.checked_add(size)?)?.to_vec();
    let duration = if timescale > 0 { duration as f64 / f64::from(timescale) } else { 0.0 };
    Some(Track { codec, width, height, duration, sample, color })
}

// ── WebM / Matroska ──
fn webm(bytes: &[u8]) -> Option<Track> {
    use matroska_demuxer::{Frame, MatrixCoefficients, MatroskaFile, Range, TrackType};
    let mut file = MatroskaFile::open(Cursor::new(bytes)).ok()?;
    let track = file.tracks().iter().find(|t| t.track_type() == TrackType::Video)?;
    let number = track.track_number().get();
    // (…an EBML string may carry trailing NULs: some muxers pad `V_VP8` with them)
    let codec = match track.codec_id().trim_end_matches('\0') {
        "V_MPEG4/ISO/AVC" => Codec::H264(track.codec_private()?.to_vec()),
        "V_AV1" => Codec::Av1(track.codec_private()?.get(4..)?.to_vec()),
        "V_VP8" => Codec::Vp8,
        "V_VP9" => Codec::Vp9,
        _ => Codec::Other,
    };
    let video = track.video()?;
    let (width, height) = (u32::try_from(video.pixel_width().get()).ok()?, u32::try_from(video.pixel_height().get()).ok()?);
    let color = video.colour().and_then(|c| {
        let matrix = match c.matrix_coefficients()? {
            MatrixCoefficients::Identity => 0,
            MatrixCoefficients::Bt709 => 1,
            MatrixCoefficients::Bt470bg | MatrixCoefficients::Smpte170 => 6,
            MatrixCoefficients::Bt2020Ncl => 9,
            _ => return None,
        };
        Some(Color { matrix, full_range: c.range() == Some(Range::Full) })
    });
    let scale = file.info().timestamp_scale().get() as f64;
    let duration = file.info().duration().map_or(0.0, |d| d * scale / 1e9);
    let mut frame = Frame::default();
    while file.next_frame(&mut frame).ok()? {
        if frame.track == number {
            return Some(Track { codec, width, height, duration, sample: std::mem::take(&mut frame.data), color });
        }
    }
    None
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "decodeVideo", decode_video, context_id);
}

// __dom.decodeVideo(bytes) -> a video resource (a Uint8Array) decoded to its first frame (`decode`): `{width, height,
// duration, pixels}` (`pixels` a Uint8ClampedArray, RGBA), or null where it is no video we can play. A decoder that
// panics on a corrupt file has decoded nothing.
fn decode_video(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let video = crate::canvas::bytes_read(args.get(0), None).and_then(|bytes| std::panic::catch_unwind(|| decode(&bytes)).ok().flatten());
    let Some(video) = video else { return rv.set_null() };
    let obj = v8::Object::new(scope);
    let width = v8::Integer::new_from_unsigned(scope, video.width).into();
    let height = v8::Integer::new_from_unsigned(scope, video.height).into();
    let duration = v8::Number::new(scope, video.duration).into();
    let pixels = crate::dom::u8_clamped_array(scope, video.rgba);
    for (key, value) in [("width", width), ("height", height), ("duration", duration), ("pixels", pixels)] {
        let key = v8::String::new(scope, key).expect("a short string");
        obj.set(scope, key.into(), value);
    }
    rv.set(obj.into());
}

#[cfg(test)]
mod tests {
    use super::*;

    // WPT's own videos: the codec, size and first pixel of each.
    #[test]
    fn decodes_the_first_frame_of_each_codec() {
        let first = |path: &str| {
            let bytes = std::fs::read(format!("../../spec/wpt/{path}")).unwrap();
            decode(&bytes).map(|v| (v.width, v.height, v.rgba[..4].to_vec(), (v.duration * 10.0).round() / 10.0))
        };
        // (…H.264 High and VP8, a 2 × 2 green; H.264 Constrained Baseline and VP9, 320 × 240)
        let green = |p: &[u8]| p[0] < 60 && p[1] > 100 && p[2] < 60;
        let (w, h, px, _) = first("media/2x2-green.mp4").expect("H.264");
        assert!((w, h) == (2, 2) && green(&px), "{px:?}");
        let (w, h, px, _) = first("media/2x2-green.webm").expect("VP8");
        assert!((w, h) == (2, 2) && green(&px), "{px:?}");
        assert_eq!(first("media/movie_5.mp4").map(|v| (v.0, v.1, v.3)), Some((320, 240, 5.0)));
        assert_eq!(first("media/movie_5.webm").map(|v| (v.0, v.1)), Some((320, 240)));
        // (…a codec ID padded with a NUL; HEVC, no video we can play)
        assert_eq!(first("media/white.webm").map(|v| (v.0, v.1, v.2)), Some((320, 240, vec![255, 255, 255, 255])));
        assert!(first("html/canvas/element/manual/wide-gamut-canvas/resources/Rec2020-3FF000000.mp4").is_none());
    }
}
