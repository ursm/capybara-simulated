// An audio resource's duration, read off its container — no sample is decoded (media.rs: the element's metadata is all
// an `<audio>` has here): a WAV's data chunk over its byte rate, an MP4's (M4A's) movie header's duration over its time
// scale, an Ogg Vorbis or Opus stream's last granule position over its sample rate (Opus less its pre-skip), a FLAC
// stream's total samples over its sample rate, an MP3's frame count (its Xing / Info or VBRI header's) or — a constant bit
// rate one with neither — its length over its bit rate. The container sniffed first, so one of another kind is never read
// as an MP3 a stray sync word starts (an ADTS AAC stream's, a Matroska one's say nothing of their length: None). None for
// all else, or one that says no length: its duration not known (+Infinity, as HTML has it — Chrome's for a raw AAC).

pub(crate) fn duration(bytes: &[u8]) -> Option<f64> {
    let b = bytes;
    let d = if b.starts_with(b"RIFF") {
        wav(b)
    } else if b.get(4..8) == Some(b"ftyp") {
        mp4(b)
    } else if b.starts_with(b"OggS") {
        ogg(b)
    } else if b.starts_with(b"fLaC") {
        flac(b)
    } else if b.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) || (b.len() > 1 && b[0] == 0xff && b[1] & 0xf6 == 0xf0) {
        None
    } else {
        mp3(b)
    };
    d.filter(|d| d.is_finite() && *d > 0.0)
}

fn u16_le(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}
fn u32_le(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn u32_be(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

// RIFF WAVE: the `fmt ` chunk's byte rate, the `data` chunk's size.
fn wav(b: &[u8]) -> Option<f64> {
    if b.get(0..4)? != b"RIFF" || b.get(8..12)? != b"WAVE" {
        return None;
    }
    let (mut at, mut rate, mut data) = (12, None, None);
    while at + 8 <= b.len() {
        let size = u32_le(b, at + 4)? as usize;
        match &b[at..at + 4] {
            b"fmt " => rate = u32_le(b, at + 16),
            b"data" => data = Some(size.min(b.len().saturating_sub(at + 8))),
            _ => {}
        }
        at += 8 + size + (size & 1);
    }
    let rate = rate.filter(|&r| r > 0)?;
    Some(data? as f64 / f64::from(rate))
}

// MP4: the `moov` box's `mvhd` — its time scale and duration (version 1's 64-bit) — the top-level boxes walked to it.
fn mp4(b: &[u8]) -> Option<f64> {
    let boxes = |within: &[u8], name: &[u8; 4]| -> Option<(usize, usize)> {
        let mut at = 0;
        while at + 8 <= within.len() {
            let size = match u32_be(within, at)? as usize {
                1 => usize::try_from(u64::from_be_bytes(within.get(at + 8..at + 16)?.try_into().ok()?)).ok()?,
                0 => within.len() - at,
                size => size,
            };
            if size < 8 {
                return None;
            }
            if &within[at + 4..at + 8] == name {
                return Some((at, size.min(within.len() - at)));
            }
            at += size;
        }
        None
    };
    let (moov, size) = boxes(b, b"moov")?;
    let inner = &b[moov + 8..moov + size];
    let (mvhd, _) = boxes(inner, b"mvhd")?;
    let h = &inner[mvhd + 8..];
    let (scale, length) = if *h.first()? == 1 {
        (u32_be(h, 20)?, u64::from_be_bytes(h.get(24..32)?.try_into().ok()?))
    } else {
        (u32_be(h, 12)?, u64::from(u32_be(h, 16)?))
    };
    (scale > 0 && length != u64::MAX && length != u64::from(u32::MAX)).then(|| length as f64 / f64::from(scale))
}

// Ogg: the first page's identification header (Vorbis: its sample rate; Opus: 48 kHz, less its pre-skip) and the
// granule position of the last page of that stream — a page whose header holds (version 0, its serial number, its
// segment table within the bytes), a stray `OggS` in a packet none.
fn ogg(b: &[u8]) -> Option<f64> {
    let serial = u32_le(b, 14)?;
    let segments = *b.get(26)? as usize;
    let packet = 27 + segments;
    let (rate, skip) = if b.get(packet..packet + 7)? == b"\x01vorbis" {
        (u32_le(b, packet + 12)?, 0)
    } else if b.get(packet..packet + 8)? == b"OpusHead" {
        (48_000, u16_le(b, packet + 10)?)
    } else {
        return None;
    };
    let page = |at: usize| b.get(at + 4) == Some(&0) && u32_le(b, at + 14) == Some(serial) && b.get(at + 26).is_some_and(|&n| at + 27 + usize::from(n) <= b.len());
    let last = (0..b.len().saturating_sub(27)).rev().find(|&at| &b[at..at + 4] == b"OggS" && page(at))?;
    let granule = u64::from_le_bytes(b.get(last + 6..last + 14)?.try_into().ok()?);
    (rate > 0 && granule != u64::MAX).then(|| granule.saturating_sub(u64::from(skip)) as f64 / f64::from(rate))
}

// FLAC: STREAMINFO's sample rate (20 bits) and total samples (36 bits).
fn flac(b: &[u8]) -> Option<f64> {
    let info = b.get(8..26)?;
    let rate = (u32::from(info[10]) << 12) | (u32::from(info[11]) << 4) | (u32::from(info[12]) >> 4);
    let total = (u64::from(info[13] & 0x0f) << 32) | u64::from(u32_be(info, 14)?);
    (rate > 0 && total > 0).then(|| total as f64 / f64::from(rate))
}

// MPEG audio: its first frame — past an ID3v2 tag, a sync word whose frame the next frame's header follows — its Xing /
// Info header's frame count, else its VBRI one's, else a constant bit rate over the rest.
fn mp3(b: &[u8]) -> Option<f64> {
    let mut at = 0;
    if b.get(0..3)? == b"ID3" {
        let size = b.get(6..10)?.iter().fold(0usize, |n, &x| (n << 7) | usize::from(x & 0x7f));
        at = 10 + size;
    }
    let framed = |i: usize| header(&b[i..]).is_some_and(|h| b.get(i + h.length..).and_then(header).is_some());
    let start = (at..b.len().saturating_sub(4)).take(64 * 1024).find(|&i| b[i] == 0xff && b[i + 1] & 0xe0 == 0xe0 && framed(i))?;
    let h = header(&b[start..])?;
    let side = match (h.mpeg1, h.mono) {
        (true, false) => 32,
        (true, true) => 17,
        (false, false) => 17,
        (false, true) => 9,
    };
    let xing = start + 4 + side;
    let frames = if matches!(b.get(xing..xing + 4), Some(b"Xing" | b"Info")) && u32_be(b, xing + 4)? & 1 != 0 {
        Some(u32_be(b, xing + 8)?)
    } else if b.get(start + 36..start + 40) == Some(b"VBRI") {
        u32_be(b, start + 36 + 14)
    } else {
        None
    };
    match frames {
        Some(frames) => Some(f64::from(frames) * f64::from(h.samples) / f64::from(h.rate)),
        None => Some((b.len() - start) as f64 * 8.0 / f64::from(h.bitrate)),
    }
}
struct Header {
    mpeg1: bool,
    mono: bool,
    // In bits per second, and samples per second; and the samples a frame carries.
    bitrate: u32,
    rate: u32,
    samples: u32,
    // Its frame's length in bytes, header included.
    length: usize,
}
fn header(b: &[u8]) -> Option<Header> {
    let (version, layer) = ((b.get(1)? >> 3) & 3, (b[1] >> 1) & 3);
    if version == 1 || layer != 1 {
        return None;
    }
    let mpeg1 = version == 3;
    let index = usize::from(b.get(2)? >> 4);
    const V1: [u32; 16] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const V2: [u32; 16] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
    let kbps = if mpeg1 { V1[index] } else { V2[index] };
    let base = [44_100, 48_000, 32_000, 0][usize::from((b[2] >> 2) & 3)];
    let rate = match version {
        3 => base,
        2 => base / 2,
        _ => base / 4,
    };
    let samples = if mpeg1 { 1152 } else { 576 };
    let padding = usize::from((b[2] >> 1) & 1);
    let length = (samples / 8 * kbps * 1000 / rate.max(1)) as usize + padding;
    (kbps > 0 && rate > 0 && length > 4).then_some(Header { mpeg1, mono: b.get(3)? >> 6 == 3, bitrate: kbps * 1000, rate, samples, length })
}

#[cfg(test)]
mod tests {
    use super::duration;

    #[test]
    fn reads_a_wav_and_an_mp3_and_an_ogg() {
        let mut wav = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        wav.extend(16u32.to_le_bytes());
        wav.extend([1, 0, 1, 0]);
        wav.extend(8000u32.to_le_bytes());
        wav.extend(8000u32.to_le_bytes());
        wav.extend([1, 0, 8, 0]);
        wav.extend(b"data");
        wav.extend(4000u32.to_le_bytes());
        wav.extend([0x80; 4000]);
        assert_eq!(duration(&wav), Some(0.5));
        let media = |f: &str| std::fs::read(format!("{}/../../spec/wpt/media/{f}", env!("CARGO_MANIFEST_DIR"))).unwrap();
        assert!((duration(&media("sound_5.mp3")).unwrap() - 5.0).abs() < 0.1);
        assert!((duration(&media("sound_5.oga")).unwrap() - 5.0).abs() < 0.1);
        assert_eq!(duration(b"not audio"), None);
        // (…an ADTS AAC stream's sync word is no MP3's, nor is an MP4's box data)
        assert_eq!(duration(&[0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]), None);
        assert!((duration(&media("movie_5.mp4")).unwrap() - 5.0).abs() < 0.2);
    }
}
