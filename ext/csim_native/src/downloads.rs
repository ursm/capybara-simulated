// A response a navigation saves rather than renders, and the name it is saved under: one whose `Content-Disposition`
// is `attachment` or names a file (RFC 6266 §4.2 — any explicit filename makes it a download, as Chrome has it), saved
// under that filename (§4.3), else the one a `<a download>` suggests, else the last segment of its URL's path. The host
// fetches it and writes the file.

// Whether a response whose `Content-Disposition` is `cd` downloads: its type `attachment`, or a `filename` parameter.
pub(crate) fn is_download(cd: &[u8]) -> bool {
    cd.split(|&b| b == b';').any(|part| {
        let part = part.trim_ascii_start().to_ascii_lowercase();
        part.starts_with(b"attachment") || part.strip_prefix(b"filename").is_some_and(|rest| rest.trim_ascii_start().starts_with(b"="))
    })
}

// The parameters of a `Content-Disposition` (after its type), by name lowercased — the first of each — a quoted-string's
// value unescaped, a `;` or `=` inside one no separator; lenient, as browsers parse one: an unterminated quote runs to the
// end.
fn params(cd: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut found: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    let mut i = cd.iter().position(|&b| b == b';').map_or(cd.len(), |p| p + 1);
    while i < cd.len() {
        let rest = &cd[i..];
        let name_start = i + rest.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(rest.len());
        let name_len = cd[name_start..].iter().position(|&b| b.is_ascii_whitespace() || b == b'=' || b == b';').unwrap_or(cd.len() - name_start);
        let name = cd[name_start..name_start + name_len].to_ascii_lowercase();
        let mut j = name_start + name_len;
        while j < cd.len() && cd[j].is_ascii_whitespace() {
            j += 1;
        }
        if name.is_empty() || j >= cd.len() || cd[j] != b'=' {
            // (…no `name=value`: skip to the next parameter)
            i = cd[j.min(cd.len())..].iter().position(|&b| b == b';').map_or(cd.len(), |p| j + p + 1);
            continue;
        }
        j += 1;
        while j < cd.len() && cd[j].is_ascii_whitespace() {
            j += 1;
        }
        let mut value = Vec::new();
        if cd.get(j) == Some(&b'"') {
            j += 1;
            while j < cd.len() && cd[j] != b'"' {
                if cd[j] == b'\\' && j + 1 < cd.len() {
                    j += 1;
                }
                value.push(cd[j]);
                j += 1;
            }
            // (…past the closing quote, and to the next `;`)
            j = cd[j.min(cd.len())..].iter().position(|&b| b == b';').map_or(cd.len(), |p| j + p + 1);
        } else {
            let end = cd[j..].iter().position(|&b| b == b';').map_or(cd.len(), |p| j + p);
            value.extend_from_slice(cd[j..end].trim_ascii());
            j = end + 1;
        }
        if !found.iter().any(|(n, _)| *n == name) {
            found.push((name, value));
        }
        i = j;
    }
    found
}

// An ext-value's text (RFC 8187 §3.2): `charset'language'value`, its bytes percent-decoded and decoded in that charset —
// None where it is none, or its charset one the Encoding Standard does not know, or its bytes no text in it.
fn ext_value_text(ext: &[u8]) -> Option<String> {
    let first = ext.iter().position(|&b| b == b'\'')?;
    let second = first + 1 + ext[first + 1..].iter().position(|&b| b == b'\'')?;
    let charset = &ext[..first];
    if charset.is_empty() || !charset.iter().all(|&b| b.is_ascii_alphanumeric() || b"!#$%&+^_`{}~-".contains(&b)) {
        return None;
    }
    let encoding = encoding_rs::Encoding::for_label(charset)?;
    let mut bytes = Vec::new();
    let mut rest = &ext[second + 1..];
    while let Some((&b, tail)) = rest.split_first() {
        if b == b'%' {
            let hex = tail.get(..2).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok())?;
            bytes.push(hex);
            rest = &tail[2..];
        } else {
            bytes.push(b);
            rest = tail;
        }
    }
    let text = encoding.decode_without_bom_handling_and_without_replacement(&bytes)?;
    (!text.contains('\0')).then(|| text.into_owned())
}

// The name a download whose `Content-Disposition` is `cd` is saved under (RFC 6266 §4.3): `filename*`'s ext-value where
// it decodes, else `filename`'s, its bytes UTF-8 where they are (Chrome: a raw UTF-8 name), else each byte the code point
// it is; trimmed, and no directory of it (`../x` is `x`). None for none, and for a name no file can have (`.`, `..`, one
// holding a NUL).
pub(crate) fn disposition_filename(cd: &[u8]) -> Option<String> {
    let params = params(cd);
    let get = |name: &[u8]| params.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_slice());
    let name = get(b"filename*").and_then(ext_value_text).or_else(|| {
        get(b"filename").map(|plain| match std::str::from_utf8(plain) {
            Ok(text) => text.to_owned(),
            Err(_) => plain.iter().map(|&b| b as char).collect(),
        })
    })?;
    plain_name(&name)
}

// `name` as a file's: its last segment by `/` or `\`, trimmed — none for one of no file (empty, `.`, `..`, a NUL).
fn plain_name(name: &str) -> Option<String> {
    if name.contains('\0') {
        return None;
    }
    let name = name.replace('\\', "/");
    let last = name.trim_end_matches('/').rsplit('/').next().unwrap_or("").trim();
    (!matches!(last, "" | "." | "..")).then(|| last.to_owned())
}

// The name a download of `url` is saved under: its `Content-Disposition`'s (`cd`, none for none), else the one its
// `<a download>` suggests (`hint`), else the last segment of the URL's path — 'download' where none gives one.
pub(crate) fn filename(cd: Option<&[u8]>, url: &str, hint: &str) -> String {
    cd.and_then(disposition_filename)
        .or_else(|| plain_name(hint))
        .or_else(|| ada_url::Url::parse(url, None).ok().and_then(|u| plain_name(u.pathname())))
        .unwrap_or_else(|| "download".to_owned())
}

// A header's text as the host hands it over — each byte a code point (`header_text`) — its bytes again.
fn header_bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?')).collect()
}
pub(crate) fn is_download_for_ruby(cd: Option<String>) -> bool {
    cd.is_some_and(|cd| is_download(&header_bytes(&cd)))
}
pub(crate) fn filename_for_ruby(cd: Option<String>, url: String, hint: Option<String>) -> String {
    filename(cd.map(|cd| header_bytes(&cd)).as_deref(), &url, hint.as_deref().unwrap_or(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_disposition_downloads_as_an_attachment_or_with_a_filename() {
        assert!(is_download(b"attachment"));
        assert!(is_download(b"Attachment; filename=a.txt"));
        assert!(is_download(b"inline; filename=\"a.txt\""));
        assert!(is_download(b"inline; FILENAME = a.txt"));
        assert!(!is_download(b"inline"));
        assert!(!is_download(b"inline; name=a"));
    }

    #[test]
    fn a_filename_is_its_ext_value_over_its_plain_one() {
        assert_eq!(disposition_filename(b"attachment; filename*=UTF-8''%C3%A9t%C3%A9.csv; filename=\"f.csv\"").as_deref(), Some("été.csv"));
        assert_eq!(disposition_filename(b"attachment; filename*=UTF-8''a%00b.txt; filename=\"plain.txt\"").as_deref(), Some("plain.txt"));
        assert_eq!(disposition_filename(b"attachment; filename*=iso-8859-1'en'%E9.txt").as_deref(), Some("é.txt"));
        assert_eq!(disposition_filename(b"attachment; filename*=bogus''x.txt; filename=y.txt").as_deref(), Some("y.txt"));
        assert_eq!(disposition_filename("attachment; filename=\"café.txt\"".as_bytes()).as_deref(), Some("café.txt"));
        assert_eq!(disposition_filename(b"attachment; filename=\"bad\xE9.txt\"").as_deref(), Some("badé.txt"));
        assert_eq!(disposition_filename(b"attachment; filename=\"a\\\"b;c.txt\"").as_deref(), Some("a\"b;c.txt"));
        // (…the first of a name, and none of no file)
        assert_eq!(disposition_filename(b"attachment; filename=a.txt; filename=b.txt").as_deref(), Some("a.txt"));
        assert_eq!(disposition_filename(b"attachment; filename=\"../../escape.txt\"").as_deref(), Some("escape.txt"));
        assert_eq!(disposition_filename(b"attachment; filename=\"..\""), None);
        assert_eq!(disposition_filename(b"attachment"), None);
    }

    #[test]
    fn a_name_falls_back_to_the_hint_then_the_url() {
        assert_eq!(filename(None, "http://a.test/r/report.csv?x", ""), "report.csv");
        assert_eq!(filename(None, "http://a.test/r/report.csv", "mine.csv"), "mine.csv");
        assert_eq!(filename(Some(b"attachment; filename=d.txt"), "http://a.test/x", "mine.csv"), "d.txt");
        assert_eq!(filename(Some(b"attachment"), "http://a.test/", ""), "download");
    }
}
