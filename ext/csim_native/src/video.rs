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

// The first video track: what codes it, its size and duration, its first sample, the colour the container tags, the
// size it is displayed at where its pixels are not square (`pasp`, WebM's DisplayWidth / DisplayHeight), and the
// quarter turns clockwise it is displayed turned by (`tkhd`'s matrix).
struct Track {
    codec: Codec,
    width: u32,
    height: u32,
    duration: f64,
    sample: Vec<u8>,
    color: Option<Color>,
    display: Option<(u32, u32)>,
    turns: u8,
}

// `bytes` decoded to its first frame — None where it is no video we can play, or one larger than an image may be
// (`image_decode::MAX_AREA`, checked against the container's size and, before decoding, the bitstream's).
pub(crate) fn decode(bytes: &[u8]) -> Option<Video> {
    let track = if bytes.get(4..8) == Some(b"ftyp") { mp4(bytes)? } else { webm(bytes)? };
    if !crate::image_decode::fits(track.width, track.height) {
        return None;
    }
    let (width, height, rgba, sar) = first_frame(&track)?;
    // (…displayed at its display size — the container's, else the bitstream's pixel aspect ratio — then turned)
    let display = track.display.or_else(|| sar.map(|(h, v)| (((u64::from(width) * u64::from(h) + u64::from(v) / 2) / u64::from(v)) as u32, height)));
    let (mut width, mut height, mut rgba) = (width, height, rgba);
    if let Some((dw, dh)) = display.filter(|&(dw, dh)| (dw, dh) != (width, height) && dw > 0 && dh > 0 && crate::image_decode::fits(dw, dh)) {
        let img = image::RgbaImage::from_raw(width, height, rgba)?;
        rgba = image::imageops::resize(&img, dw, dh, image::imageops::FilterType::Triangle).into_raw();
        (width, height) = (dw, dh);
    }
    if track.turns % 4 != 0 {
        let img = image::RgbaImage::from_raw(width, height, rgba)?;
        let turned = match track.turns % 4 {
            1 => image::imageops::rotate90(&img),
            2 => image::imageops::rotate180(&img),
            _ => image::imageops::rotate270(&img),
        };
        (width, height, rgba) = (turned.width(), turned.height(), turned.into_raw());
    }
    Some(Video { width, height, duration: track.duration, rgba })
}

// The first frame, RGBA: its coded size, its pixels, and the pixel aspect ratio its bitstream gives (H.264's VUI).
// Its colour: the container's tag, else the bitstream's, else what an untagged stream is taken for — BT.709 at 720
// lines or more, BT.601 below (Chrome's choice, measured), limited range.
fn first_frame(t: &Track) -> Option<(u32, u32, Vec<u8>, Option<(u32, u32)>)> {
    let untagged = |height: usize| Color { matrix: if height >= 720 { 1 } else { 6 }, full_range: false };
    let color = |bitstream: Option<Color>, height: usize| t.color.or(bitstream).unwrap_or(untagged(height));
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
            if !crate::image_decode::fits(w as u32, h as u32) {
                return None;
            }
            let vui = avcc_sps(avcc).and_then(|sps| sps_vui(&sps)).unwrap_or_default();
            let tagged = vui.full_range.map(|full_range| Color { matrix: vui.matrix.unwrap_or(untagged(h).matrix), full_range });
            let (ys, us, vs) = frame.strides();
            let planes = Planes { width: w, height: h, bit_depth: 8, ss: (1, 1), y: (frame.y(), ys), uv: Some([(frame.u(), us), (frame.v(), vs)]) };
            Some((w as u32, h as u32, planes.rgba(color(tagged, h))?, vui.sar))
        }
        Codec::Av1(config) => {
            let obus = [config.as_slice(), &t.sample].concat();
            let frame = crate::av1::frame(&obus)?;
            Some((frame.width, frame.height, frame.rgba, None))
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
            Some((w as u32, h as u32, planes.rgba(color(None, h))?, None))
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
            Some((w as u32, h as u32, planes.rgba(color(vp9_color(&header), h))?, None))
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

// The first sequence parameter set of an `avcC`.
fn avcc_sps(avcc: &[u8]) -> Option<Vec<u8>> {
    if avcc.get(5)? & 0x1F == 0 {
        return None;
    }
    let len = usize::from(u16::from_be_bytes([*avcc.get(6)?, *avcc.get(7)?]));
    Some(avcc.get(8..8 + len)?.to_vec())
}

// What an H.264 SPS's VUI says of the picture (ITU-T H.264 §E.1.1): its range, its matrix coefficients, its sample
// aspect ratio.
#[derive(Default)]
struct Vui {
    full_range: Option<bool>,
    matrix: Option<u32>,
    sar: Option<(u32, u32)>,
}

// An SPS NAL unit (with its header byte) read up to its VUI (§7.3.2.1.1): None where it has none, or is cut short.
fn sps_vui(nal: &[u8]) -> Option<Vui> {
    // (…the RBSP: the emulation-prevention 3 of each 00 00 03 dropped)
    let mut rbsp = Vec::with_capacity(nal.len());
    for &b in nal.get(1..)? {
        if b == 3 && rbsp.ends_with(&[0, 0]) {
            continue;
        }
        rbsp.push(b);
    }
    let mut r = Bits { data: &rbsp, at: 0 };
    let profile = r.bits(8)?;
    r.bits(16)?; // (…constraint flags, level)
    r.ue()?; // seq_parameter_set_id
    if matches!(profile, 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135) {
        if r.ue()? == 3 {
            r.bits(1)?; // separate_colour_plane_flag
        }
        r.ue()?;
        r.ue()?; // bit depths
        r.bits(1)?; // qpprime_y_zero_transform_bypass_flag
        if r.bits(1)? == 1 {
            // (…scaling lists: each present one's deltas skipped)
            for i in 0..8 {
                if r.bits(1)? == 1 {
                    let size = if i < 6 { 16 } else { 64 };
                    let (mut last, mut next) = (8i64, 8i64);
                    for _ in 0..size {
                        if next != 0 {
                            next = (last + r.se()? + 256) % 256;
                        }
                        last = if next == 0 { last } else { next };
                    }
                }
            }
        }
    }
    r.ue()?; // log2_max_frame_num_minus4
    match r.ue()? {
        0 => {
            r.ue()?;
        }
        1 => {
            r.bits(1)?;
            r.se()?;
            r.se()?;
            for _ in 0..r.ue()? {
                r.se()?;
            }
        }
        _ => {}
    }
    r.ue()?;
    r.bits(1)?; // max_num_ref_frames, gaps_in_frame_num_value_allowed_flag
    r.ue()?;
    r.ue()?; // pic_width_in_mbs_minus1, pic_height_in_map_units_minus1
    if r.bits(1)? == 0 {
        r.bits(1)?; // mb_adaptive_frame_field_flag
    }
    r.bits(1)?; // direct_8x8_inference_flag
    if r.bits(1)? == 1 {
        for _ in 0..4 {
            r.ue()?;
        }
    }
    if r.bits(1)? == 0 {
        return None;
    }
    let mut vui = Vui::default();
    if r.bits(1)? == 1 {
        vui.sar = match r.bits(8)? {
            255 => Some((r.bits(16)?, r.bits(16)?)),
            idc => [(1, 1), (12, 11), (10, 11), (16, 11), (40, 33), (24, 11), (20, 11), (32, 11), (80, 33), (18, 11), (15, 11), (64, 33), (160, 99), (4, 3), (3, 2), (2, 1)].get(idc.checked_sub(1)? as usize).copied(),
        }
        .filter(|&(h, v)| h > 0 && v > 0);
    }
    if r.bits(1)? == 1 {
        r.bits(1)?; // overscan_appropriate_flag
    }
    if r.bits(1)? == 1 {
        r.bits(3)?; // video_format
        vui.full_range = Some(r.bits(1)? == 1);
        if r.bits(1)? == 1 {
            r.bits(16)?; // colour_primaries, transfer_characteristics
            vui.matrix = Some(r.bits(8)?).filter(|&m| m != 2);
        }
    }
    Some(vui)
}

// A big-endian bit reader, with H.264's Exp-Golomb codes.
struct Bits<'a> {
    data: &'a [u8],
    at: usize,
}

impl Bits<'_> {
    fn bits(&mut self, n: u32) -> Option<u32> {
        let mut v = 0u32;
        for _ in 0..n {
            let byte = *self.data.get(self.at / 8)?;
            v = v << 1 | u32::from(byte >> (7 - self.at % 8) & 1);
            self.at += 1;
        }
        Some(v)
    }
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bits(1)? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1u32 << zeros) - 1 + self.bits(zeros)?)
    }
    fn se(&mut self) -> Option<i64> {
        let k = i64::from(self.ue()?);
        Some(if k % 2 == 1 { (k + 1) / 2 } else { -k / 2 })
    }
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
// …each with where its payload starts in `data`.
fn boxes_at(data: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8], usize)> {
    let base = data.as_ptr() as usize;
    boxes(data).map(move |(kind, payload)| (kind, payload, payload.as_ptr() as usize - base))
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
    // `tkhd`: the track's id, and its matrix's turn (a, b of the 16.16 matrix: 0, 1 is a quarter turn clockwise)
    let tkhd = child(trak, b"tkhd")?;
    let wide = tkhd.first() == Some(&1);
    let track_id = be32(tkhd, if wide { 20 } else { 12 })?;
    let at = if wide { 52 } else { 40 };
    let (a, b) = (be32(tkhd, at)? as i32, be32(tkhd, at + 4)? as i32);
    let turns = match (a.signum(), b.signum()) {
        (0, 1) => 1,
        (-1, 0) => 2,
        (0, -1) => 3,
        _ => 0,
    };
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
    // `pasp`: the pixel aspect ratio, hSpacing : vSpacing.
    let display = child(inner, b"pasp").and_then(|p| {
        let (h, v) = (u64::from(be32(p, 0)?), u64::from(be32(p, 4)?));
        (h > 0 && v > 0 && h != v).then(|| (((u64::from(width) * h + v / 2) / v) as u32, height))
    });
    // The first sample: at its chunk's offset, its size the table's first (or the one size every sample has) — or, in
    // a fragmented file whose sample table is empty, the first fragment's.
    let stsz = child(stbl, b"stsz")?;
    let mut fragmented_ticks = None;
    let sample = if be32(stsz, 8)? == 0 {
        let (sample, ticks) = fragments(bytes, moov, track_id)?;
        fragmented_ticks = Some(ticks);
        sample
    } else {
        let size = match be32(stsz, 4)? {
            0 => be32(stsz, 12)?,
            n => n,
        } as usize;
        let offset = match child(stbl, b"stco") {
            Some(stco) => u64::from(be32(stco, 8)?),
            None => u64::from_be_bytes(child(stbl, b"co64")?.get(8..16)?.try_into().ok()?),
        } as usize;
        bytes.get(offset..offset.checked_add(size)?)?.to_vec()
    };
    // (…a fragmented file's duration is where its last fragment ends, where its `mdhd` gives none)
    let duration = match (duration, fragmented_ticks) {
        (0, Some(ticks)) => ticks,
        (d, _) => d,
    };
    let duration = if timescale > 0 { duration as f64 / f64::from(timescale) } else { 0.0 };
    Some(Track { codec, width, height, duration, sample, color, display, turns })
}

// A fragmented MP4's track `track_id` (ISO/IEC 14496-12 §8.8): its first sample — the first `moof` with a `traf` for
// it, its `trun`'s first sample, at the base the `tfhd` gives (an explicit offset, else the `moof`'s start) plus the
// `trun`'s data offset, its size the `trun`'s, else the `tfhd`'s default, else the movie's `trex` — and where its last
// fragment ends, in its timescale (each fragment's `tfdt` start plus its samples' durations, defaulted the same way).
fn fragments(bytes: &[u8], moov: &[u8], track_id: u32) -> Option<(Vec<u8>, u64)> {
    let trex = child(moov, b"mvex").and_then(|m| boxes(m).filter(|(k, _)| k == b"trex").map(|(_, p)| p).find(|t| be32(t, 4) == Some(track_id)));
    let (trex_duration, trex_size) = (trex.and_then(|t| be32(t, 12)), trex.and_then(|t| be32(t, 16)));
    let mut first: Option<Vec<u8>> = None;
    let mut end = 0u64;
    for (kind, moof, at) in boxes_at(bytes) {
        if kind != *b"moof" {
            continue;
        }
        let moof_start = at - 8;
        for traf in boxes(moof).filter(|(k, _)| k == b"traf").map(|(_, p)| p) {
            let tfhd = child(traf, b"tfhd")?;
            let flags = be32(tfhd, 0)? & 0xFF_FFFF;
            if be32(tfhd, 4)? != track_id {
                continue;
            }
            let mut i = 8;
            let base = if flags & 0x01 != 0 {
                let b = u64::from_be_bytes(tfhd.get(i..i + 8)?.try_into().ok()?) as usize;
                i += 8;
                b
            } else {
                moof_start
            };
            if flags & 0x02 != 0 {
                i += 4;
            }
            let default_duration = if flags & 0x08 != 0 {
                let d = be32(tfhd, i);
                i += 4;
                d
            } else {
                trex_duration
            };
            let default_size = if flags & 0x10 != 0 { be32(tfhd, i) } else { trex_size };
            let start_ticks = child(traf, b"tfdt").and_then(|t| if t.first() == Some(&1) { Some(u64::from_be_bytes(t.get(4..12)?.try_into().ok()?)) } else { be32(t, 4).map(u64::from) }).unwrap_or(end);
            let trun = child(traf, b"trun")?;
            let tflags = be32(trun, 0)? & 0xFF_FFFF;
            let count = be32(trun, 4)?;
            let mut j = 8;
            let offset = if tflags & 0x01 != 0 {
                let o = be32(trun, j)? as i32;
                j += 4;
                o
            } else {
                0
            };
            if tflags & 0x04 != 0 {
                j += 4;
            }
            // (…each sample's record: duration, size, flags, composition offset, those its flags say it has)
            let record = [0x100, 0x200, 0x400, 0x800].iter().filter(|&&f| tflags & f != 0).count() * 4;
            let mut ticks = 0u64;
            for k in 0..count as usize {
                let at = j + k * record;
                let duration = if tflags & 0x100 != 0 { be32(trun, at) } else { default_duration };
                ticks += u64::from(duration.unwrap_or(0));
                if first.is_none() && k == 0 {
                    let size_at = at + if tflags & 0x100 != 0 { 4 } else { 0 };
                    let size = if tflags & 0x200 != 0 { be32(trun, size_at) } else { default_size }? as usize;
                    let start = usize::try_from(base as i64 + i64::from(offset)).ok()?;
                    first = Some(bytes.get(start..start.checked_add(size)?)?.to_vec());
                }
            }
            end = end.max(start_ticks + ticks);
        }
    }
    Some((first?, end))
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
    // (…a display size other than the coded one: pixels that are not square)
    let display = video.display_width().zip(video.display_height()).map(|(w, h)| (w.get() as u32, h.get() as u32)).filter(|&d| d != (width, height));
    let scale = file.info().timestamp_scale().get() as f64;
    let duration = file.info().duration().map_or(0.0, |d| d * scale / 1e9);
    let mut frame = Frame::default();
    while file.next_frame(&mut frame).ok()? {
        if frame.track == number {
            return Some(Track { codec, width, height, duration, sample: std::mem::take(&mut frame.data), color, display, turns: 0 });
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
